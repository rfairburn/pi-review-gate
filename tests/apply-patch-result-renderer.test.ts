import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APPLY_PATCH_TOOL_NAME, registerApplyPatchTool } from "../src/apply-patch/tool";
import { isExpandableResult } from "../src/tool-result-expansion";

const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};

function componentLines(component: unknown, width = 400): string[] {
  assert.ok(component && typeof (component as { render?: unknown }).render === "function");
  return (component as { render(width: number): string[] }).render(width);
}

function envelope(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-review-apply-renderer-"));
  const tools: Array<Record<string, any>> = [];
  registerApplyPatchTool({ registerTool: (tool: Record<string, any>) => tools.push(tool) });
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
  return { cwd, tool };
}

test("registered ApplyPatch collapsed and expanded arms match the canonical single-update card", async () => {
  const { cwd, tool } = await fixture();
  try {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "status.ts"), 'export const status = "pending";\n', "utf8");
    const secret = "MODEL_VISIBLE_SECRET_sk_live_ABCDEF1234567890";
    const patch = envelope(
      "*** Update File: src/status.ts",
      "@@",
      '-export const status = "pending";',
      `+export const status = "ready"; // ${secret}`,
    );
    const params = { patch };
    const beforeRender = JSON.stringify(params);
    const result = await tool.execute("canonical-update", params, undefined, undefined, { cwd });

    assert.equal(isExpandableResult(tool.renderResult), true);
    const collapsedLines = componentLines(tool.renderResult(result, { expanded: false, isPartial: false }, theme, { args: params }));
    const collapsed = collapsedLines.join("\n");
    const expandedLines = componentLines(tool.renderResult(result, { expanded: true, isPartial: false }, theme, { args: params }));
    const expanded = expandedLines.join("\n");

    // Canonical collapsed card: header + indented per-file row, no raw model
    // summary and no legacy bounded diff previews.
    assert.equal(collapsedLines[0], "ApplyPatch · 1 file updated");
    assert.ok(collapsedLines.some((line) => line === "  M src/status.ts · +1 −1"), collapsed);
    assert.doesNotMatch(collapsed, /Success\. Updated the following files/);
    assert.doesNotMatch(collapsed, /Final diff:|Requested diff:/);
    // The shared expansion wrapper owns the hint; the family renderer never
    // emits one and never hard-codes a binding.
    assert.doesNotMatch(collapsed, /ctrl\+o/);

    // Canonical expanded card: complete original call patch and complete
    // retained final diff, in the canonical section order.
    assert.equal(expandedLines[0], "ApplyPatch · succeeded");
    const requestedAt = expanded.indexOf("Requested patch:");
    const appliedAt = expanded.indexOf("Applied operations:");
    const finalDiffAt = expanded.indexOf("Final diff:");
    assert.ok(requestedAt >= 0 && appliedAt > requestedAt && finalDiffAt > appliedAt, expanded);
    for (const line of patch.split("\n")) {
      assert.ok(expandedLines.includes(line), `missing requested-patch line: ${line}`);
    }
    assert.ok(expandedLines.some((line) => line.startsWith("M src/status.ts")), expanded);
    const finalDiff = String(result.details.finalDiff);
    assert.ok(finalDiff.length > 0);
    for (const line of finalDiff.split("\n")) {
      assert.ok(expandedLines.includes(line), `missing final-diff line: ${line}`);
    }
    // Complete original model input, secret-shaped content included, with no
    // human-view redaction or truncation layer.
    assert.match(expanded, /MODEL_VISIBLE_SECRET_sk_live_ABCDEF1234567890/);
    assert.doesNotMatch(expanded, /\[\.\.\. truncated \.\.\.\]/);
    assert.equal(JSON.stringify(params), beforeRender, "rendering must not mutate model-visible input");
    assert.equal(await readFile(join(cwd, "src", "status.ts"), "utf8"), `export const status = "ready"; // ${secret}\n`);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("registered ApplyPatch multi-operation card distinguishes create/update/delete/move beyond old caps", async () => {
  const { cwd, tool } = await fixture();
  try {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "mover.ts"), "before\n", "utf8");
    await writeFile(join(cwd, "src", "big.ts"), "seed\n", "utf8");
    await writeFile(join(cwd, "old.txt"), "obsolete\n", "utf8");
    const secretTail = "MODEL_VISIBLE_SECRET_TAIL_9f8e7d6c";
    const updateLines = Array.from({ length: 320 }, (_unused, index) =>
      `+line-${index}-${index === 319 ? secretTail : "body"}`);
    const patch = envelope(
      "*** Add File: new.txt",
      "+created with MODEL_VISIBLE_SECRET_HEAD_Zk9x2Lm4",
      "*** Update File: src/big.ts",
      "@@",
      ...updateLines,
      "*** Update File: src/mover.ts",
      "*** Move to: src/moved.ts",
      "@@",
      "-before",
      "+after",
      "*** Delete File: old.txt",
    );
    assert.ok(patch.length > 4_000, "the fixture must exceed the legacy 4000-character requestedDiff cap");
    const params = { patch };
    const result = await tool.execute("multi-card", params, undefined, undefined, { cwd });

    const collapsedLines = componentLines(tool.renderResult(result, { expanded: false, isPartial: false }, theme, { args: params }));
    const collapsed = collapsedLines.join("\n");
    const expandedLines = componentLines(tool.renderResult(result, { expanded: true, isPartial: false }, theme, { args: params }));
    const expanded = expandedLines.join("\n");

    assert.equal(collapsedLines[0], "ApplyPatch · 1 file created, 2 files updated, 1 file deleted");
    for (const row of ["  A new.txt · +1 −0", "  M src/big.ts · +320 −0", "  M src/mover.ts → src/moved.ts · +1 −1", "  D old.txt · +0 −1"]) {
      assert.ok(collapsedLines.includes(row), collapsed);
    }

    assert.equal(expandedLines[0], "ApplyPatch · succeeded");
    assert.ok(expandedLines.includes("Requested patch:"));
    // The complete original patch survives expansion, including content past
    // the legacy 4000-character retained copy and the 16-line collapsed cap.
    for (const line of patch.split("\n")) {
      assert.ok(expandedLines.includes(line), `missing requested-patch line: ${line}`);
    }
    assert.ok(expandedLines.includes(`+line-319-${secretTail}`));
    assert.ok(expandedLines.some((line) => line.startsWith("A new.txt")), expanded);
    assert.ok(expandedLines.some((line) => line.startsWith("M src/mover.ts → src/moved.ts")), expanded);
    assert.ok(expandedLines.some((line) => line.startsWith("D old.txt")), expanded);
    const finalDiff = String(result.details.finalDiff);
    for (const line of finalDiff.split("\n")) {
      assert.ok(expandedLines.includes(line), `missing final-diff line: ${line}`);
    }
    assert.match(expanded, /MODEL_VISIBLE_SECRET_HEAD_Zk9x2Lm4/);
    assert.match(expanded, /MODEL_VISIBLE_SECRET_TAIL_9f8e7d6c/);
    assert.doesNotMatch(expanded, /\[\.\.\. truncated \.\.\.\]/);
    assert.doesNotMatch(collapsed, /MODEL_VISIBLE_SECRET_TAIL_9f8e7d6c/, "the collapsed card stays bounded; expansion carries the full record");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("registered ApplyPatch partial failure distinguishes applied, failed and not attempted in both states", async () => {
  const { cwd, tool } = await fixture();
  try {
    const patch = envelope(
      "*** Add File: applied.txt",
      "+kept",
      "*** Update File: missing.txt",
      "-not-present",
      "+replacement",
      "*** Add File: not-attempted.txt",
      "+never-written",
    );
    const toolCallId = "partial-failure";
    let normalized: Record<string, unknown> | undefined;
    let thrownMessage = "";
    try {
      await tool.execute(toolCallId, { patch }, undefined, undefined, { cwd });
      assert.fail("the partial ApplyPatch must reject through the tool boundary");
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error);
      // Faithful Pi adapter fixture: it keeps the native error status and
      // message, but does not copy arbitrary properties from the thrown Error.
      normalized = {
        content: [{ type: "text", text: thrownMessage }],
        details: {},
        isError: true,
      };
    }
    assert.ok(normalized);
    assert.equal(normalized.isError, true);
    const renderContext = { args: { patch }, toolCallId };
    const collapsedLines = componentLines(tool.renderResult(normalized, { expanded: false, isPartial: false }, theme, renderContext));
    const collapsed = collapsedLines.join("\n");
    const expandedLines = componentLines(tool.renderResult(normalized, { expanded: true, isPartial: false }, theme, renderContext));
    const expanded = expandedLines.join("\n");

    assert.equal(collapsedLines[0], "ApplyPatch · failed");
    assert.match(collapsed, /failed at operation 2/);
    assert.match(collapsed, /Not attempted/);
    assert.match(collapsed, /not-attempted\.txt/);

    assert.equal(expandedLines[0], "ApplyPatch · failed");
    assert.ok(expandedLines.includes("Requested patch:"));
    for (const line of patch.split("\n")) {
      assert.ok(expandedLines.includes(line), `missing requested-patch line: ${line}`);
    }
    assert.ok(expandedLines.includes("Applied operations:"));
    assert.ok(expandedLines.some((line) => line.startsWith("A applied.txt")), expanded);
    assert.match(expanded, /Failure accounting/);
    assert.match(expanded, /Stopped at operation 2/);
    assert.match(expanded, /update_file missing\.txt/);
    assert.match(expanded, /Not attempted \(1\)/);
    assert.ok(expandedLines.some((line) => line.includes("not-attempted.txt")), expanded);
    // The complete returned failure diagnostic stays visible unfiltered.
    assert.ok(expanded.includes(thrownMessage));
    assert.match(expanded, /Final diff:/);
    assert.ok(expandedLines.includes("+kept"));
    assert.equal(await readFile(join(cwd, "applied.txt"), "utf8"), "kept\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ApplyPatch uncertain effects and context-less fallbacks stay truthful without fabrication", async () => {
  const { tool } = await fixture();
  // Synthetic retained failure packet exercised through the registered
  // renderResult: uncertain effects of the failed operation must be visible.
  const details = {
    operations: [{ operation: "create_file", path: "kept.txt", changed: true, addedLines: 1, removedLines: 0, mutated: true }],
    applied: [{ operation: "create_file", path: "kept.txt", changed: true, addedLines: 1, removedLines: 0, mutated: true }],
    failed: {
      index: 1,
      operation: "create_file",
      path: "deep/nested/file.txt",
      error: "cannot write file",
      uncertainEffects: ["directory '/tmp/x/deep' was left in place (not empty)"],
    },
    notAttempted: ["later.txt"],
    requestedDiff: "*** Begin Patch\n*** Add File: kept.txt\n+kept\n*** End Patch",
  };
  const value = {
    content: [{ type: "text", text: "ApplyPatch failed at operation 2 with 1 earlier operation(s) still applied." }],
    details,
    isError: true,
  };
  const collapsed = componentLines(tool.renderResult(value, { expanded: false, isPartial: false }, theme, {})).join("\n");
  assert.equal(componentLines(tool.renderResult(value, { expanded: false, isPartial: false }, theme, {}))[0], "ApplyPatch · failed");
  assert.match(collapsed, /Not attempted \(1\): later\.txt\./);
  assert.match(collapsed, /Uncertain effect: directory '\/tmp\/x\/deep' was left in place \(not empty\)/);

  const expanded = componentLines(tool.renderResult(value, { expanded: true, isPartial: false }, theme, {})).join("\n");
  assert.match(expanded, /Requested patch retained with the result \(no native call context was available\):/);
  assert.match(expanded, /Uncertain effects of the failed operation:/);
  assert.match(expanded, /was left in place \(not empty\)/);
  assert.match(expanded, /Not attempted \(1\)/);
  assert.match(expanded, /later\.txt/);
  assert.doesNotMatch(expanded, /Final diff:/, "no final diff was retained, so none may be claimed");

  // Neither native args nor retained details: the renderer says so instead
  // of inventing a patch or a diff.
  const bare = componentLines(tool.renderResult({ content: [{ type: "text", text: "ApplyPatch updated one file." }] }, { expanded: true, isPartial: false }, theme, {})).join("\n");
  assert.match(bare, /ApplyPatch · succeeded/);
  assert.match(bare, /Requested patch was not available in the native render context\./);
  assert.match(bare, /No structured ApplyPatch details were retained with this result/);
});