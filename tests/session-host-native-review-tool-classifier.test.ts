import assert from "node:assert/strict";
import test from "node:test";

import {
  CLAUDE_READ_ONLY_TOOLS,
  CODEX_READ_ONLY_ITEM_CATEGORIES,
  isClaudeReadOnlyTool,
  isCodexReadOnlyItemCategory,
} from "../src/session-host/native-review-tool-classifier";

/**
 * The one read-only classification the native review lane uses (#736 slice 3b).
 * The rule is closed and fails toward review: only an exact listed name is
 * read-only, so a provider that adds or renames a mutating tool lands on the
 * reviewed side without this host changing.
 */

test("the Claude read-only set is exactly the names this host positively classifies", () => {
  assert.deepEqual([...CLAUDE_READ_ONLY_TOOLS].sort(), [
    "Glob",
    "Grep",
    "LS",
    "ListMcpResourcesTool",
    "NotebookRead",
    "Read",
    "ReadMcpResourceTool",
    "TodoRead",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
  ].sort());
});

test("every mutating, delegating, or MCP Claude tool is NOT read-only", () => {
  for (const toolName of [
    "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "BashOutput", "KillBash",
    "Task", "Agent", "ExitPlanMode", "KillShell", "Skill",
    "mcp__pi__review_code", "mcp__anything__read", "mcp__server__list",
  ]) {
    assert.equal(isClaudeReadOnlyTool(toolName), false, `${toolName} is never read-only`);
  }
});

test("an unknown, empty, or near-miss Claude name is NOT read-only", () => {
  for (const toolName of ["", "read", "READ", " Read", "Read ", "Reader", "ReadFile", "ls", "grep", "web_search"]) {
    assert.equal(isClaudeReadOnlyTool(toolName), false, `${JSON.stringify(toolName)} is not an exact listed name`);
  }
  // The classification is exact and case-sensitive: a provider's own spelling is
  // the only spelling this admits.
  assert.equal(isClaudeReadOnlyTool("Read"), true);
  assert.equal(isClaudeReadOnlyTool("WebSearch"), true);
});

test("the Codex read-only category set holds only web-search", () => {
  assert.deepEqual([...CODEX_READ_ONLY_ITEM_CATEGORIES], ["web-search"]);
  for (const category of ["file-change", "command", "mcp-tool", "dynamic-tool", "web_search", "WebSearch", "", "something-new"]) {
    assert.equal(isCodexReadOnlyItemCategory(category), false, `${JSON.stringify(category)} is not read-only`);
  }
  assert.equal(isCodexReadOnlyItemCategory("web-search"), true);
});

test("a non-string Codex category is NOT read-only", () => {
  for (const category of [undefined, null, 0, 1, true, false, {}, [], ["web-search"]]) {
    assert.equal(isCodexReadOnlyItemCategory(category), false);
  }
});
