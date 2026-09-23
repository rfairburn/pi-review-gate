/**
 * GitRead tool registration (#73).
 *
 * Public export contract: `registerGitReadTool(host, cwd)` registers exactly
 * one model-visible tool, `GitRead`, on any host that exposes Pi-compatible
 * `registerTool`. The engine uses the runtime cwd (supplied as a getter) to
 * select the current repository — there is no model-provided workspace, no raw
 * argv, no shell, and no mutating Git verbs. Role wiring (which operating
 * modes or clients see the tool) is deliberately NOT done here; the parent
 * owns registration policy after this interface lands.
 *
 * GitRead is a read-only research surface: it reads stored objects (history,
 * trees, blobs at revisions) and never touches the work tree, index, refs, or
 * network. Worktree/status operations are explicitly unsupported by design —
 * see the `status` action rationale returned at runtime.
 */

import { GIT_READ_LIMITS, GitReadEngine } from "./engine";

export const GIT_READ_TOOL_NAME = "GitRead";

/** Minimal host surface: Pi-compatible tool registration. */
export interface GitReadHost {
  registerTool(tool: Record<string, unknown>): unknown;
}

export interface GitReadToolOptions {
  gitPath?: string;
  timeoutMs?: number;
  commandByteCap?: number;
  snapshotTtlMs?: number;
  maxSnapshots?: number;
  maxOutputChars?: number;
}

/**
 * Registers the model-visible GitRead tool. Returns false when the host does
 * not expose registerTool (nothing is registered). Active-by-default under
 * Pi's normal registered-tool policy; role gating belongs to the caller.
 */
export function registerGitReadTool(host: GitReadHost, cwd: () => string, options: GitReadToolOptions = {}): boolean {
  if (typeof host !== "object" || host === null || typeof host.registerTool !== "function") return false;
  const engine = new GitReadEngine({ cwd, ...options });

  host.registerTool({
    name: GIT_READ_TOOL_NAME,
    label: GIT_READ_TOOL_NAME,
    description: [
      "Structured read-only Git research on the current repository (selected from the runtime working directory — you cannot target another workspace).",
      "Actions: log (history with safe range/filter/follow/author/since/until/message/pickaxe/first-parent), show (commit metadata + change inventory, or one file's patch), diff (two explicit revisions: all-files inventory, then per-file patch pages), blame (bounded line ownership), refs, mergeBase, listFiles (tree at a revision), readFile (tracked content at a revision), search (historical tracked-content grep).",
      "status/worktree-diff is unsupported by design; use two explicit revisions instead.",
      "Every result is bounded and navigable: list results carry a snapshotId with pinned full commit ids, expiry, totals, and nextIndex; continue with the same snapshotId plus index or find (never re-resolved against moved refs). maxChars bounds each page (default 20000, max 100000).",
      "Read-only: no shell, no raw git arguments, no mutations, no network.",
    ].join(" "),
    promptSnippet:
      "Use GitRead for planning-relevant repository history and revision research with structured actions (log/show/diff/blame/refs/mergeBase/listFiles/readFile/search); continue paged results via snapshotId + index/find/maxChars.",
    promptGuidelines: [
      "GitRead selects the repository from the runtime working directory; there is no workspace or path parameter that escapes it, and all paths are exact repository-relative paths (no globs, magic, or '..').",
      "List results pin every revision to a full commit id at acquisition. To page or search an existing result, pass back its snapshotId with index or find; if the snapshot expired, re-run the action without index/find to acquire a fresh one.",
      "For single-target reads (show/diff file patches, blame, readFile) the result names the exact pinned SHAs used — pass those full SHAs back for deterministic continuation.",
      "diff takes two explicit revisions (from/to). Merge commits in show are diffed against an explicit parent (default first) with the basis disclosed; pick another with parent=N.",
      "Results disclose caps and truncation (entry limits, byte caps, timeouts); a capped inventory is not claimed to be complete beyond the stated cap.",
    ],
    executionMode: "parallel",
    parameters: gitReadToolSchema(),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const result = await engine.execute(params, signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: result.isError,
      };
    },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Schema (defaults documented inline)
// ---------------------------------------------------------------------------

function objectSchema(properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function stringProp(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function integerProp(description: string): Record<string, unknown> {
  return { type: "integer", description };
}

function booleanProp(description: string): Record<string, unknown> {
  return { type: "boolean", description };
}

function gitReadToolSchema(): Record<string, unknown> {
  const L = GIT_READ_LIMITS;
  return objectSchema({
    action: {
      type: "string",
      enum: ["log", "show", "diff", "blame", "refs", "mergeBase", "listFiles", "readFile", "search", "status"],
      description:
        "Which structured Git operation to run. status is present for discovery only and always returns an explicit unsupported rationale (worktree operations are out of scope by design).",
    },
    rev: stringProp("Revision to read at (default HEAD). Used by log (single-rev history), show, blame, listFiles, readFile, search."),
    from: stringProp("Range start. log: commits in 'to' not in 'from' (from..to). diff: the older/explicit base revision (required with to)."),
    to: stringProp("Range end. log: head of the range (required with from). diff: the newer/explicit target revision (required with from)."),
    paths: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: L.maxPaths,
      description: `Exact repository-relative paths (no globs/magic/'..'), 1-${L.maxPaths}. log: restrict history to these paths. listFiles/search: restrict to these paths.`,
    },
    author: stringProp("log only: regular expression applied by git --author against the author name and email (git's default is a POSIX basic regexp — e.g. 'a\\.b' matches a literal dot, 'a\\|b' is alternation; ERE syntax like 'a|b' is NOT enabled); metacharacters are significant. When message is also set, git --fixed-strings makes the limiting patterns (including author) literal."),
    since: stringProp("log only: only commits after this date (git --since; e.g. 2.weeks.ago, 2026-01-01)."),
    until: stringProp("log only: only commits before this date (git --until)."),
    message: stringProp("log only: literal substring match on the commit message (fixed strings; not a regex)."),
    pickaxe: stringProp("log only: -S pickaxe — commits that change the number of occurrences of this literal string."),
    pickaxePattern: stringProp("log only: -G pickaxe — commits whose diff lines match this git regex pattern."),
    follow: booleanProp("log only: track renames; requires exactly one path (default false)."),
    firstParent: booleanProp("log only: follow only the first parent of merges (default false)."),
    reverse: booleanProp("log only: oldest-first ordering instead of newest-first (default false)."),
    limit: integerProp(`log only: maximum commits to acquire, 1-${L.logMaxLimit} (default ${L.logDefaultLimit}). The result reports the total matching count so you know if more exist.`),
    file: stringProp("show/diff only: exact repository-relative path whose patch page to read instead of the inventory."),
    parent: integerProp("show only: for merge commits, which parent (1-based, default 1 = first parent) to diff against; the basis is always disclosed."),
    path: stringProp("blame/readFile only: exact repository-relative file path (required)."),
    startLine: integerProp("blame only: 1-based inclusive first line of the blame window."),
    endLine: integerProp(`blame only: 1-based inclusive last line; the window is capped at ${L.blameMaxLinesPerCall} lines per call.`),
    pattern: stringProp("refs: refname glob filter (e.g. refs/heads/*); option-like values (leading '-') are rejected so git options cannot be injected. search: the text to find in tracked content at rev."),
    fixedStrings: booleanProp("search only: treat pattern as a literal string instead of a git regex (default true)."),
    caseInsensitive: booleanProp("search only: match case-insensitively (default false)."),
    a: stringProp("mergeBase only: first revision (required)."),
    b: stringProp("mergeBase only: second revision (required)."),
    snapshotId: stringProp("Continuation token from a previous list result (log/refs/listFiles/search). Required for index>0 or find; the pinned snapshot is served without re-resolving revisions."),
    index: integerProp("Page start: entry offset for list results (with snapshotId), line offset for show/diff file patches, readFile content, and blame (resume line = index+1). Default 0."),
    find: stringProp("Case-insensitive substring search within an acquired snapshot (log/refs/listFiles/search); returns matching entry indices to read via index. Requires the snapshot's data already acquired (pass snapshotId for continuations)."),
    maxChars: integerProp(`Maximum characters in the returned page, ${L.maxCharsMin}-${Math.min(L.maxCharsMax, 100_000)} (default ${L.maxCharsDefault}). nextIndex tells you where to continue.`),
  }, ["action"]);
}
