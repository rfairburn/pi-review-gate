/**
 * #736 slice 3b: the one read-only classification this host's native review lane
 * uses for a hosted native row's own tool activity.
 *
 * A native Claude row reports its root tool activity through the existing
 * observe-only hook lane (./native-hook-protocol), and a future Codex row reports
 * its own item categories. The review lane may use that classification for one
 * thing only: what this row's own review coordinator decides to look at. It is
 * never a permission decision, never an approval, and never a claim that the
 * provider was prevented from doing anything — the provider's own permission
 * posture stays entirely the provider's.
 *
 * The classification is deliberately closed and fails toward review: a tool,
 * category, or spelling this module does not positively name as read-only is NOT
 * read-only. An unknown name is never assumed harmless, so a provider that adds
 * a new mutating tool, or renames one, lands on the reviewed side of the line
 * without this file changing.
 */

/**
 * The exact Claude Code tool names this host classifies as read-only. Nothing
 * else is: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, `Bash`, `Task`, `Agent`,
 * every `mcp__*` name, and every unknown name are all NOT read-only.
 */
export const CLAUDE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
  "NotebookRead",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/**
 * True only for an exact {@linkcode CLAUDE_READ_ONLY_TOOLS} name. Matching is
 * exact and case-sensitive: Claude's own tool names are the only spelling this
 * admits, and a near-miss (`"read"`, `"Bash"`, `"mcp__server__read"`) is not a
 * read-only tool here.
 */
export function isClaudeReadOnlyTool(toolName: string): boolean {
  return typeof toolName === "string" && CLAUDE_READ_ONLY_TOOLS.has(toolName);
}

/**
 * The exact Codex item categories this host classifies as read-only. A Codex
 * `web-search` item mutates nothing in the row's workspace; `file-change`,
 * `command`, `mcp-tool`, `dynamic-tool`, and anything else are not.
 */
export const CODEX_READ_ONLY_ITEM_CATEGORIES: ReadonlySet<string> = new Set(["web-search"]);

/**
 * True only for an exact {@linkcode CODEX_READ_ONLY_ITEM_CATEGORIES} name. The
 * value is `unknown` because it reaches here from provider data: a non-string,
 * an empty string, or an unlisted category is NOT read-only.
 */
export function isCodexReadOnlyItemCategory(category: unknown): boolean {
  return typeof category === "string" && CODEX_READ_ONLY_ITEM_CATEGORIES.has(category);
}
