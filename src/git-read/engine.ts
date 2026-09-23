/**
 * GitRead engine (#73): safe structured Git research with indexed navigation.
 *
 * The engine exposes Git-native read-only semantics as typed actions instead
 * of raw commands: history planning (`log`), commit inspection (`show`),
 * revision comparison (`diff`), line ownership (`blame`), and justified
 * read operations (`refs`, `mergeBase`, `listFiles`, `readFile`, `search`).
 * Worktree/status operations are deliberately unsupported (see the `status`
 * action rationale): GitRead only reads stored objects, where configured
 * filter/attribute programs cannot run.
 *
 * Navigation contract (mirrors WebFetch/SubtasksInspect identity semantics):
 * - Every result that lists items acquires a bounded canonical snapshot and
 *   returns a `snapshotId`, acquisition time, expiry, the repository root, and
 *   the full pinned object ids actually used. Revisions are resolved to full
 *   40-hex commit ids before any query runs, so a moved HEAD can never change
 *   an acquired snapshot.
 * - Continuation (`index` > 0 or `find`) requires that `snapshotId` and is
 *   served from the in-memory snapshot: no re-resolution, no `^lastSha`-style
 *   range arithmetic, no re-execution against a moved ref. Snapshots are
 *   bounded (LRU + TTL); expiry/eviction returns an explicit error telling the
 *   model to re-acquire — never a silent fresh resolution.
 * - Single-target reads (`show`/`diff` file patches, `blame`, `readFile`)
 *   re-resolve on each call but always disclose the exact pinned ids used, so
 *   continuation can pass those full SHAs back and stay deterministic.
 * - Every output is bounded by entry caps, byte caps, timeouts, and the
 *   model-controlled `maxChars` window; overflow is disclosed (`truncated`,
 *   totals), never silently dropped.
 */

import { auditRepository, EMPTY_TREE_SHA, GitReadError, pinRevision, resolveRepoRoot, runGit, runGitBytePrefix, runGitPagedLines, snapshotToken } from "./git";

// ---------------------------------------------------------------------------
// Limits (documented in the tool schema)
// ---------------------------------------------------------------------------

export const GIT_READ_LIMITS = {
  /** log: default and maximum entries per acquisition (`limit`). */
  logDefaultLimit: 200,
  logMaxLimit: 2000,
  /** diff/show inventory: maximum files listed per acquisition. */
  fileInventoryCap: 4096,
  /** refs: maximum refs listed per acquisition (enforced with --count). */
  refsCap: 4096,
  /** listFiles: maximum tree entries per acquisition. */
  listFilesCap: 20_000,
  /** search: maximum matches per acquisition. */
  searchMatchCap: 500,
  /** blame: maximum lines blamed per call (window size). */
  blameMaxLinesPerCall: 2000,
  /** readFile: maximum blob bytes returned as content. */
  readFileMaxBytes: 262_144,
  /** readFile: bytes probed from an over-cap blob for binary detection. */
  readFileProbeBytes: 65_536,
  /** maxChars window bounds. */
  maxCharsMin: 500,
  maxCharsDefault: 20_000,
  maxCharsMax: 100_000,
  /** find: maximum matches reported per snapshot. */
  findMaxMatches: 25,
  /** Maximum repo-relative paths per call. */
  maxPaths: 64,
} as const;

export interface GitReadEngineOptions {
  /** Absolute-path provider for the repository to research (runtime cwd). */
  cwd: () => string;
  /** git executable (default "git"). */
  gitPath?: string;
  /** Wall-clock cap per git command, ms (default 20000). */
  timeoutMs?: number;
  /** Hard stdout byte cap per git command (default 8 MiB). */
  commandByteCap?: number;
  /** Snapshot lifetime, ms (default 600000 = 10 min). */
  snapshotTtlMs?: number;
  /** Maximum retained snapshots (LRU) (default 64). */
  maxSnapshots?: number;
  /** Upper bound for the model-controlled maxChars window (default 100000). */
  maxOutputChars?: number;
}

export interface GitReadResult {
  text: string;
  details: Record<string, unknown>;
  isError: boolean;
}

interface EngineConfig {
  cwd: () => string;
  gitPath: string;
  timeoutMs: number;
  commandByteCap: number;
  snapshotTtlMs: number;
  maxSnapshots: number;
  maxOutputChars: number;
}

// ---------------------------------------------------------------------------
// Snapshot store (bounded LRU with TTL)
// ---------------------------------------------------------------------------

interface StoredSnapshot {
  id: string;
  action: string;
  repoRoot: string;
  acquiredAt: string;
  expiresAt: number;
  lastAccess: number;
  pinned: Record<string, string>;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Parsed item types
// ---------------------------------------------------------------------------

export interface LogEntry {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  subject: string;
}

interface LogSnapshotData {
  entries: LogEntry[];
  /** null when the total cannot be computed (e.g. --follow queries). */
  totalCommits: number | null;
  limit: number;
  /** Human-readable description of the acquired query (for result headers). */
  query: string;
}

export interface DiffFileEntry {
  status: string;
  path: string;
  oldPath?: string;
  added: number | null;
  removed: number | null;
  binary: boolean;
}

interface InventorySnapshotData {
  files: DiffFileEntry[];
  truncated: boolean;
}

export interface RefEntry {
  refname: string;
  type: string;
  sha: string;
  peeledSha?: string;
  committerDate?: string;
}

interface RefsSnapshotData {
  refs: RefEntry[];
  truncated: boolean;
  /** The acquired pattern, echoed in continuation headers. */
  pattern?: string;
}

export interface TreeFileEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
}

interface ListFilesSnapshotData {
  files: TreeFileEntry[];
  truncated: boolean;
  /** The acquired path filter, echoed in continuation headers. */
  paths?: string[];
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  textTruncated: boolean;
}

interface SearchSnapshotData {
  matches: SearchMatch[];
  truncated: boolean;
  /** The acquired query, echoed in continuation headers. */
  pattern: string;
  fixedStrings: boolean;
  caseInsensitive: boolean;
}

// ---------------------------------------------------------------------------
// Parameter parsing (typed, fail-closed validation)
// ---------------------------------------------------------------------------

type GitReadAction =
  | "log" | "show" | "diff" | "blame" | "refs"
  | "mergeBase" | "listFiles" | "readFile" | "search" | "status";

const ACTIONS: readonly GitReadAction[] = [
  "log", "show", "diff", "blame", "refs", "mergeBase", "listFiles", "readFile", "search", "status",
];

interface CommonParams {
  index: number;
  find?: string;
  maxChars: number;
  snapshotId?: string;
}

interface StatusParams {
  action: "status";
}

interface LogParams extends CommonParams {
  action: "log";
  rev?: string;
  from?: string;
  to?: string;
  paths: string[] | undefined;
  author?: string;
  since?: string;
  until?: string;
  message?: string;
  pickaxe?: string;
  pickaxePattern?: string;
  follow: boolean;
  firstParent: boolean;
  reverse: boolean;
  limit: number;
}

interface ShowParams extends CommonParams {
  action: "show";
  rev: string;
  file?: string;
  parent?: number;
}

interface DiffParams extends CommonParams {
  action: "diff";
  from: string;
  to: string;
  file?: string;
}

interface BlameParams extends CommonParams {
  action: "blame";
  rev: string;
  path: string;
  startLine?: number;
  endLine?: number;
}

interface RefsParams extends CommonParams {
  action: "refs";
  pattern?: string;
}

interface MergeBaseParams {
  action: "mergeBase";
  a: string;
  b: string;
}

interface ListFilesParams extends CommonParams {
  action: "listFiles";
  rev: string;
  paths: string[] | undefined;
}

interface ReadFileParams extends CommonParams {
  action: "readFile";
  rev: string;
  path: string;
}

interface SearchParams extends CommonParams {
  action: "search";
  pattern: string;
  rev: string;
  paths: string[] | undefined;
  fixedStrings: boolean;
  caseInsensitive: boolean;
}

type AnyParams =
  | LogParams | ShowParams | DiffParams | BlameParams | RefsParams
  | MergeBaseParams | ListFilesParams | ReadFileParams | SearchParams | StatusParams;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Revision specs: non-empty, bounded, no control chars, no leading dash. */
function validateRevision(value: unknown, field: string): string {
  if (typeof value !== "string") throw new GitReadError(`${field} must be a string revision spec`, "invalid_request");
  const spec = value.trim();
  if (!spec) throw new GitReadError(`${field} must be a non-empty revision spec (e.g. HEAD, main, v1.0, or a full commit id)`, "invalid_request");
  if (spec.length > 256) throw new GitReadError(`${field} exceeds the 256-character limit`, "invalid_request");
  if (/[\u0000\n\r]/.test(spec)) throw new GitReadError(`${field} contains control characters`, "invalid_request");
  if (spec.startsWith("-")) {
    throw new GitReadError(
      `${field} '${spec}' starts with a dash; revision specs must not start with '-' (option-like values are rejected for safety)`,
      "invalid_request",
    );
  }
  return spec;
}

/** Repo-relative paths: no escape, no absolute, no pathspec magic or globs. */
function validateRepoPath(value: unknown, field: string): string {
  if (typeof value !== "string") throw new GitReadError(`${field} must be a string path`, "invalid_request");
  const path = value;
  if (!path) throw new GitReadError(`${field} must be a non-empty repository-relative path`, "invalid_request");
  if (path.length > 4096) throw new GitReadError(`${field} exceeds the 4096-character limit`, "invalid_request");
  if (/[\u0000\n\r]/.test(path)) throw new GitReadError(`${field} contains control characters`, "invalid_request");
  if (path.startsWith("/") || path.startsWith("~")) {
    throw new GitReadError(`${field} '${path}' must be repository-relative (no absolute or ~ paths)`, "invalid_request");
  }
  if (path.startsWith("-") || path.startsWith(":") || path.startsWith("!")) {
    throw new GitReadError(
      `${field} '${path}' uses a reserved prefix; provide an exact repository-relative path without option, pathspec-magic, or negation prefixes`,
      "invalid_request",
    );
  }
  if (path.includes(":(")) {
    throw new GitReadError(`${field} '${path}' contains pathspec magic ':(...)' which is not allowed; provide an exact repository-relative path`, "invalid_request");
  }
  if (/[*?[]/.test(path)) {
    throw new GitReadError(`${field} '${path}' contains glob characters; only exact repository-relative paths are accepted (no wildcards)`, "invalid_request");
  }
  const components = path.split("/");
  for (const component of components) {
    if (component === "" ) throw new GitReadError(`${field} '${path}' contains an empty path component`, "invalid_request");
    if (component === "..") throw new GitReadError(`${field} '${path}' escapes the repository with '..'; use a path relative to the repository root`, "invalid_request");
    if (component === ".") throw new GitReadError(`${field} '${path}' contains a '.' component; use a clean repository-relative path`, "invalid_request");
  }
  return path;
}

function validatePathArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GitReadError(`${field} must be an array of repository-relative paths`, "invalid_request");
  if (value.length < 1 || value.length > GIT_READ_LIMITS.maxPaths) {
    throw new GitReadError(`${field} must contain 1-${GIT_READ_LIMITS.maxPaths} paths`, "invalid_request");
  }
  return value.map((item, i) => validateRepoPath(item, `${field}[${i}]`));
}

/** Free-text patterns (author/message/pickaxe/grep/find): bounded, no control chars. */
function validatePattern(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== "string") throw new GitReadError(`${field} must be a string`, "invalid_request");
  const pattern = value.trim();
  if (!pattern) throw new GitReadError(`${field} must be non-empty`, "invalid_request");
  if (pattern.length > maxLength) throw new GitReadError(`${field} exceeds the ${maxLength}-character limit`, "invalid_request");
  if (/[\u0000\n\r]/.test(pattern)) throw new GitReadError(`${field} contains control characters`, "invalid_request");
  return pattern;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new GitReadError(`${field} must be a non-empty string when provided`, "invalid_request");
  return validatePattern(value, field);
}

function boundedInt(value: unknown, min: number, max: number, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new GitReadError(`${field} must be an integer from ${min} through ${max}`, "invalid_request");
  }
  return n;
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new GitReadError(`${field} must be a boolean`, "invalid_request");
  return value;
}

/**
 * Parses and validates the full parameter object. Unknown fields are rejected
 * so typos fail loudly instead of being silently ignored.
 */
function parseParams(raw: unknown, maxOutputChars: number): AnyParams {
  if (!isRecord(raw)) throw new GitReadError("GitRead parameters must be an object with an action field", "invalid_request");
  const rawAction = raw.action;
  if (typeof rawAction !== "string" || !(ACTIONS as readonly string[]).includes(rawAction)) {
    throw new GitReadError(`action must be one of: ${ACTIONS.join(", ")}`, "invalid_request");
  }
  const action = rawAction as GitReadAction;

  // Fields are listed per action on purpose: an accepted-but-ignored field
  // would silently change what the model believes happened.
  const knownByAction: Record<GitReadAction, readonly string[]> = {
    log: ["action", "rev", "from", "to", "paths", "author", "since", "until", "message", "pickaxe", "pickaxePattern", "follow", "firstParent", "reverse", "limit", "index", "find", "maxChars", "snapshotId"],
    show: ["action", "rev", "file", "parent", "index", "maxChars"],
    diff: ["action", "from", "to", "file", "index", "maxChars"],
    blame: ["action", "rev", "path", "startLine", "endLine", "index", "maxChars"],
    refs: ["action", "pattern", "index", "find", "maxChars", "snapshotId"],
    mergeBase: ["action", "a", "b"],
    listFiles: ["action", "rev", "paths", "index", "find", "maxChars", "snapshotId"],
    readFile: ["action", "rev", "path", "index", "maxChars"],
    search: ["action", "pattern", "rev", "paths", "fixedStrings", "caseInsensitive", "index", "find", "maxChars", "snapshotId"],
    status: ["action"],
  };
  const allowed = new Set(knownByAction[action]!);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new GitReadError(`action '${action}' does not accept field(s): ${unknown.join(", ")}`, "invalid_request");
  }

  const maxChars = boundedInt(
    raw.maxChars,
    GIT_READ_LIMITS.maxCharsMin,
    Math.min(GIT_READ_LIMITS.maxCharsMax, maxOutputChars),
    GIT_READ_LIMITS.maxCharsDefault,
    "maxChars",
  );
  const index = boundedInt(raw.index, 0, Number.MAX_SAFE_INTEGER, 0, "index");
  const find = raw.find === undefined ? undefined : validatePattern(raw.find, "find");
  const snapshotId = raw.snapshotId === undefined ? undefined : validatePattern(raw.snapshotId, "snapshotId", 128);
  const common: CommonParams = { maxChars, index, ...(find ? { find } : {}), ...(snapshotId ? { snapshotId } : {}) };

  switch (action) {
    case "log": {
      const rev = raw.rev === undefined ? undefined : validateRevision(raw.rev, "rev");
      const from = raw.from === undefined ? undefined : validateRevision(raw.from, "from");
      const to = raw.to === undefined ? undefined : validateRevision(raw.to, "to");
      if (rev && (from || to)) throw new GitReadError("log takes either rev or both from and to — not a mix", "invalid_request");
      if ((from && !to) || (!from && to)) throw new GitReadError("log range requires both from and to (commits in to that are not in from)", "invalid_request");
      const limit = boundedInt(raw.limit, 1, GIT_READ_LIMITS.logMaxLimit, GIT_READ_LIMITS.logDefaultLimit, "limit");
      return {
        action,
        ...common,
        ...(rev ? { rev } : {}),
        ...(from && to ? { from, to } : {}),
        paths: validatePathArray(raw.paths, "paths"),
        author: optionalString(raw.author, "author"),
        since: optionalString(raw.since, "since"),
        until: optionalString(raw.until, "until"),
        message: optionalString(raw.message, "message"),
        pickaxe: optionalString(raw.pickaxe, "pickaxe"),
        pickaxePattern: optionalString(raw.pickaxePattern, "pickaxePattern"),
        follow: optionalBoolean(raw.follow, false, "follow"),
        firstParent: optionalBoolean(raw.firstParent, false, "firstParent"),
        reverse: optionalBoolean(raw.reverse, false, "reverse"),
        limit,
      };
    }
    case "show": {
      const parent = raw.parent === undefined ? undefined : boundedInt(raw.parent, 1, 32, 1, "parent");
      return {
        action,
        ...common,
        rev: validateRevision(raw.rev ?? "HEAD", "rev"),
        ...(raw.file !== undefined ? { file: validateRepoPath(raw.file, "file") } : {}),
        ...(parent !== undefined ? { parent } : {}),
      };
    }
    case "diff": {
      const from = raw.from === undefined ? undefined : validateRevision(raw.from, "from");
      const to = raw.to === undefined ? undefined : validateRevision(raw.to, "to");
      if (!from || !to) throw new GitReadError("diff requires both from and to revisions (two explicit commits; worktree diff is not supported)", "invalid_request");
      return {
        action,
        ...common,
        from,
        to,
        ...(raw.file !== undefined ? { file: validateRepoPath(raw.file, "file") } : {}),
      };
    }
    case "blame": {
      const startLine = raw.startLine === undefined ? undefined : boundedInt(raw.startLine, 1, Number.MAX_SAFE_INTEGER, 1, "startLine");
      const endLine = raw.endLine === undefined ? undefined : boundedInt(raw.endLine, 1, Number.MAX_SAFE_INTEGER, 1, "endLine");
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        throw new GitReadError("blame endLine must be >= startLine", "invalid_request");
      }
      return {
        action,
        ...common,
        rev: validateRevision(raw.rev ?? "HEAD", "rev"),
        path: validateRepoPath(raw.path, "path"),
        ...(startLine !== undefined ? { startLine } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
      };
    }
    case "refs": {
      const pattern = raw.pattern === undefined ? undefined : validatePattern(raw.pattern, "pattern", 256);
      if (pattern && pattern.startsWith("-")) {
        throw new GitReadError(
          `pattern '${pattern}' starts with a dash; provide a refname glob (e.g. refs/heads/*), not a git option — option-like values are rejected so the fixed for-each-ref format cannot be overridden`,
          "invalid_request",
        );
      }
      return {
        action,
        ...common,
        ...(pattern !== undefined ? { pattern } : {}),
      };
    }
    case "mergeBase": {
      return {
        action,
        a: validateRevision(raw.a, "a"),
        b: validateRevision(raw.b, "b"),
      };
    }
    case "listFiles": {
      return {
        action,
        ...common,
        rev: validateRevision(raw.rev ?? "HEAD", "rev"),
        paths: validatePathArray(raw.paths, "paths"),
      };
    }
    case "readFile": {
      return {
        action,
        ...common,
        rev: validateRevision(raw.rev ?? "HEAD", "rev"),
        path: validateRepoPath(raw.path, "path"),
      };
    }
    case "search": {
      return {
        action,
        ...common,
        pattern: validatePattern(raw.pattern, "pattern"),
        rev: validateRevision(raw.rev ?? "HEAD", "rev"),
        paths: validatePathArray(raw.paths, "paths"),
        fixedStrings: optionalBoolean(raw.fixedStrings, true, "fixedStrings"),
        caseInsensitive: optionalBoolean(raw.caseInsensitive, false, "caseInsensitive"),
      };
    }
    case "status": {
      return { action };
    }
  }
}

// ---------------------------------------------------------------------------
// Output parsers
// ---------------------------------------------------------------------------

const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s";

function parseLogEntries(stdout: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const fields = line.split("\x1f");
    if (fields.length < 9) continue;
    const [sha, parents, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = fields;
    entries.push({
      sha: sha ?? "",
      parents: (parents ?? "").split(" ").filter(Boolean),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorDate: authorDate ?? "",
      committerName: committerName ?? "",
      committerEmail: committerEmail ?? "",
      committerDate: committerDate ?? "",
      subject: fields.slice(8).join("\x1f"),
    });
  }
  return entries;
}

/** Parses `--name-status -z` output: STATUS\0path\0 (C/R records add old\0new). */
function parseNameStatusZ(stdout: string): Array<{ status: string; path: string; oldPath?: string }> {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const out: Array<{ status: string; path: string; oldPath?: string }> = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i]!;
    if (!/^[A-Z]\d{0,3}$/.test(status)) { i += 1; continue; } // defensive: skip malformed
    const path = tokens[i + 1];
    if (path === undefined) break;
    // Only C and R records carry two pathnames; every other status (including
    // T) has one. A lookahead test misparses a rename/copy whose new pathname
    // is itself status-shaped (e.g. "A", "R100").
    if (/^[RC]/.test(status) && i + 2 < tokens.length) {
      out.push({ status, path: tokens[i + 2]!, oldPath: path });
      i += 3;
    } else {
      out.push({ status, path });
      i += 2;
    }
  }
  return out;
}

/**
 * Parses `--numstat -z` output. Normal record: "a\tb\tpath\0". Rename record:
 * "a\tb\t\0old\0new\0" — the counts token carries a trailing tab, then old
 * and new path tokens follow (verified against real git). Binary files use "-".
 */
function parseNumstatZ(stdout: string): Map<string, { added: number | null; removed: number | null }> {
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i]!;
    // Split off exactly the two count fields: with -z git emits pathnames
    // verbatim, so the remainder after the second tab is the pathname and may
    // itself contain tabs (splitting the whole record would corrupt it).
    const firstTab = head.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : head.indexOf("\t", firstTab + 1);
    const parseCount = (value: string): number | null => (value === "-" ? null : /^\d+$/.test(value) ? Number(value) : null);
    if (firstTab <= 0 || secondTab <= firstTab) {
      i += 1; // defensive: skip malformed
      continue;
    }
    const added = parseCount(head.slice(0, firstTab));
    const removed = parseCount(head.slice(firstTab + 1, secondTab));
    const path = head.slice(secondTab + 1);
    if (path !== "") {
      stats.set(path, { added, removed });
      i += 1;
    } else if (i + 2 < tokens.length) {
      // Rename: the counts token carries a trailing tab, then old and new
      // path tokens follow before the next record.
      const oldPath = tokens[i + 1]!;
      const newPath = tokens[i + 2]!;
      stats.set(`${oldPath}\u0000${newPath}`, { added, removed });
      i += 3;
    } else {
      i += 1; // defensive: skip malformed
    }
  }
  return stats;
}

/** Parses `ls-tree -r -l -z` records: "<mode> <type> <sha><padded size>\t<path>". */
function parseLsTreeZ(stdout: string): TreeFileEntry[] {
  const entries: TreeFileEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (!record) continue;
    // With -z git emits pathnames verbatim, so a pathname may itself contain
    // tabs; the metadata prefix is space-separated, so the FIRST tab is the
    // pathname separator (lastIndexOf would split inside a tab-containing
    // path and silently drop the entry).
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const head = record.slice(0, tab);
    const path = record.slice(tab + 1);
    const match = head.match(/^(\d{6}) (blob|tree|commit) ([0-9a-f]{4,64})\s+(\d+|-)$/);
    if (!match) continue; // defensive: skip malformed
    entries.push({
      path,
      mode: match[1]!,
      type: match[2] as TreeFileEntry["type"],
      sha: match[3]!,
      size: match[4] === "-" ? null : Number(match[4]),
    });
  }
  return entries;
}

/** Parses `git blame --porcelain` into per-line records. */
export interface BlameLine {
  line: number;
  commit: string;
  author: string;
  authorDate: string;
  summary: string;
  originalLine: number;
}

function parseBlamePorcelain(stdout: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const rows = stdout.split("\n");
  let i = 0;
  while (i < rows.length) {
    const header = rows[i]!;
    const match = header.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
    if (!match) { i += 1; continue; }
    const commit = match[1]!;
    const originalLine = Number(match[2]!);
    const line = Number(match[3]!);
    const count = match[4] !== undefined ? Number(match[4]!) : 1;
    let author = "";
    let authorTime = "";
    let summary = "";
    i += 1;
    // KV lines are unindented; the record's content line is tab-indented and
    // the next record's header (if any) matches the sha pattern. Stop at either.
    while (i < rows.length && !rows[i]!.startsWith("\t") && !/^[0-9a-f]{40} \d+ \d+/.test(rows[i]!)) {
      const row = rows[i]!;
      const space = row.indexOf(" ");
      const key = space > 0 ? row.slice(0, space) : row;
      const value = space > 0 ? row.slice(space + 1) : "";
      if (key === "author") author = value;
      else if (key === "author-time") authorTime = value;
      else if (key === "summary") summary = value;
      i += 1;
    }
    const authorDate = authorTime ? new Date(Number(authorTime) * 1000).toISOString() : "";
    // Every blamed line gets its own header record; the optional count field
    // only reports the hunk length, so emit exactly one record per header.
    void count;
    lines.push({ line, commit, author, authorDate, summary, originalLine });
    // The record ends with its tab-prefixed content line. Porcelain records
    // are not separated by blank lines: the next header (if any) follows
    // immediately after the content line.
    if (i < rows.length && rows[i]!.startsWith("\t")) i += 1;
  }
  return lines;
}

/** Parses `for-each-ref` tab-separated output. */
function parseForEachRef(stdout: string): RefEntry[] {
  const refs: RefEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    refs.push({
      refname: parts[0]!,
      type: parts[1]!,
      sha: parts[2]!,
      ...(parts[3] ? { peeledSha: parts[3] } : {}),
      ...(parts[4] ? { committerDate: parts[4] } : {}),
    });
  }
  return refs;
}

/** Parses `git grep -n` output "<sha>:<path>:<line>:<text>". */
/**
 * Parses `git grep -n -I -z <pattern> <sha>` output. Each match record is
 * `<sha>:<path>\0<lineno>\0<text>\n` (verified against the installed git):
 * NUL terminates the file name — which keeps the `<rev>:` prefix and may
 * itself contain ':' — then the line number, then a second NUL, then the
 * matched text terminated by a newline. -I excludes binary files, so the
 * text cannot contain NUL bytes.
 */
function parseGrepLines(stdout: string, sha: string): SearchMatch[] {
  const prefix = `${sha}:`;
  const matches: SearchMatch[] = [];
  for (const record of stdout.split("\n")) {
    if (!record.startsWith(prefix)) continue;
    const firstNul = record.indexOf("\0");
    if (firstNul < 0) continue;
    const secondNul = record.indexOf("\0", firstNul + 1);
    if (secondNul < 0) continue;
    const path = record.slice(prefix.length, firstNul);
    const lineNo = Number(record.slice(firstNul + 1, secondNul));
    if (!Number.isInteger(lineNo) || lineNo <= 0) continue;
    matches.push({ path, line: lineNo, text: record.slice(secondNul + 1), textTruncated: false });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Rendering / pagination helpers
// ---------------------------------------------------------------------------

function paginateItems(
  header: string[],
  items: ReadonlyArray<ReadonlyArray<string>>,
  index: number,
  maxChars: number,
): { text: string; nextIndex: number | null; shown: number } {
  let text = header.join("\n");
  let i = Math.min(index, items.length);
  let shown = 0;
  while (i < items.length) {
    const block = items[i]!.join("\n");
    const candidate = `${text}\n${block}`;
    if (candidate.length > maxChars && shown > 0) break;
    text = candidate;
    i += 1;
    shown += 1;
  }
  return { text, nextIndex: i < items.length ? i : null, shown };
}

function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 20))}\n[... ${value.length - max} more char(s) truncated ...]`;
}

function shortBytes(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class GitReadEngine {
  private readonly config: EngineConfig;
  private readonly snapshots = new Map<string, StoredSnapshot>();
  /** Monotonic per-engine acquisition counter (snapshot identity, Finding 1). */
  private acquisitionCounter = 0;

  constructor(options: GitReadEngineOptions) {
    this.config = {
      cwd: options.cwd,
      gitPath: options.gitPath ?? "git",
      timeoutMs: options.timeoutMs ?? 20_000,
      commandByteCap: options.commandByteCap ?? 8 * 1024 * 1024,
      snapshotTtlMs: options.snapshotTtlMs ?? 600_000,
      maxSnapshots: options.maxSnapshots ?? 64,
      maxOutputChars: options.maxOutputChars ?? GIT_READ_LIMITS.maxCharsMax,
    };
  }

  /** Tool entry point: validates params, dispatches, and never throws. */
  async execute(params: unknown, signal?: AbortSignal): Promise<GitReadResult> {
    // A continuation (snapshotId) may only carry navigation fields
    // (index/find/maxChars). Any query field sent alongside it would be
    // silently ignored — the stored acquisition is served — so reject it
    // explicitly. Checked on the RAW input: parsed defaults must not count as
    // "provided".
    if (params !== null && typeof params === "object") {
      const raw = params as Record<string, unknown>;
      if (typeof raw.snapshotId === "string") {
        const allowed = new Set(["action", "snapshotId", "index", "find", "maxChars"]);
        const stray = Object.keys(raw).filter((key) => !allowed.has(key));
        if (stray.length > 0) {
          return failureResult(new GitReadError(
            `${raw.action ?? "action"} continuation with snapshotId accepts only index/find/maxChars; the field(s) ${stray.join(", ")} belong to a fresh acquisition and would be ignored — re-run without snapshotId to change the query`,
            "invalid_request",
          ));
        }
      }
    }
    let parsed: AnyParams;
    try {
      parsed = parseParams(params, this.config.maxOutputChars);
    } catch (error) {
      return failureResult(error);
    }
    try {
      switch (parsed.action) {
        case "log": return await this.log(parsed, signal);
        case "show": return await this.show(parsed, signal);
        case "diff": return await this.diff(parsed, signal);
        case "blame": return await this.blame(parsed, signal);
        case "refs": return await this.refs(parsed, signal);
        case "mergeBase": return await this.mergeBase(parsed, signal);
        case "listFiles": return await this.listFiles(parsed, signal);
        case "readFile": return await this.readFile(parsed, signal);
        case "search": return await this.search(parsed, signal);
        case "status": return statusUnsupportedResult();
      }
    } catch (error) {
      return failureResult(error);
    }
  }

  // -- shared plumbing ------------------------------------------------------

  private async repo(signal?: AbortSignal): Promise<string> {
    const cwd = this.config.cwd();
    if (typeof cwd !== "string" || !cwd) throw new GitReadError("runtime cwd is unavailable", "not_a_repository");
    const root = await resolveRepoRoot(this.config.gitPath, cwd, this.config.timeoutMs, signal);
    await auditRepository(this.config.gitPath, root, this.config.timeoutMs, signal);
    return root;
  }

  private run(root: string, args: readonly string[], signal?: AbortSignal): Promise<Awaited<ReturnType<typeof runGit>>> {
    return runGit(this.config.gitPath, root, args, {
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.commandByteCap,
      signal,
    });
  }

  private gitFailure(action: string, out: { code: number; stderr: string }): GitReadError {
    const detail = (out.stderr.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "").slice(0, 300);
    let hint = "";
    if (/unknown revision|ambiguous argument|bad revision/i.test(out.stderr)) {
      hint = " The revision could not be resolved; use action=refs to list available refs.";
    } else if (/not a git repository/i.test(out.stderr)) {
      hint = " The directory is no longer inside a Git repository.";
    } else if (/does not exist (in (index|HEAD)|at ')/i.test(out.stderr) || /path.*did not match/i.test(out.stderr)) {
      hint = " The path may not exist at that revision; use action=listFiles to see what is tracked there.";
    }
    return new GitReadError(`git ${action} failed (exit ${out.code})${detail ? `: ${detail}` : ""}.${hint}`, "git_failed");
  }

  private storeSnapshot(id: string, action: string, repoRoot: string, pinned: Record<string, string>, data: unknown): StoredSnapshot {
    const now = Date.now();
    while (this.snapshots.size >= this.config.maxSnapshots) {
      let oldestId: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.snapshots) {
        if (value.lastAccess < oldestAt) { oldestAt = value.lastAccess; oldestId = key; }
      }
      if (oldestId === undefined) break;
      this.snapshots.delete(oldestId);
    }
    const snapshot: StoredSnapshot = {
      id,
      action,
      repoRoot,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: now + this.config.snapshotTtlMs,
      lastAccess: now,
      pinned,
      data,
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  /**
   * Snapshot identity: the hashed acquisition payload (raw query plus the
   * resolved pinned object ids) AND a per-engine acquisition counter. The
   * counter guarantees that two acquisitions of an identical query — e.g.
   * across a moved HEAD, or a refs list that changed at the same HEAD — get
   * distinct ids, so an older snapshot stays pinned and servable in the
   * bounded LRU store until TTL/expiry instead of being silently replaced by
   * Map.set. Including the pinned ids additionally makes the token depend on
   * what was actually resolved, not just what was asked for.
   */
  private nextSnapshotId(payload: Record<string, unknown>): string {
    this.acquisitionCounter += 1;
    return snapshotToken(JSON.stringify({ ...payload, acquisition: this.acquisitionCounter }));
  }

  private loadSnapshot(id: string, action: string): StoredSnapshot {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) {
      throw new GitReadError(
        `snapshot '${id}' is not available (expired or evicted); re-run the ${action} action without index/find to acquire a fresh snapshot`,
        "snapshot_expired",
      );
    }
    if (snapshot.action !== action) {
      throw new GitReadError(`snapshot '${id}' belongs to action '${snapshot.action}', not '${action}'`, "invalid_request");
    }
    if (Date.now() > snapshot.expiresAt) {
      this.snapshots.delete(id);
      throw new GitReadError(
        `snapshot '${id}' expired; re-run the ${action} action without index/find to acquire a fresh snapshot`,
        "snapshot_expired",
      );
    }
    snapshot.lastAccess = Date.now();
    return snapshot;
  }

  /** Snapshots are repo-scoped: never serve one across a repository change. */
  private assertSameRepo(currentRoot: string, snapshot: StoredSnapshot): void {
    if (snapshot.repoRoot !== currentRoot) {
      throw new GitReadError(
        `snapshot '${snapshot.id}' belongs to repository ${snapshot.repoRoot}, not the current repository ${currentRoot}; acquire a fresh snapshot here`,
        "invalid_request",
      );
    }
  }

  /**
   * Continuation pages (index > 0) must not re-resolve symbolic revision
   * specs: HEAD may have moved since the first page, and blending pages from
   * two revisions would corrupt the result. The pinned full SHA is disclosed
   * in every page header for exactly this purpose.
   */
  private requirePinnedForContinuation(index: number, spec: string, field: string): void {
    if (index <= 0) return;
    if (!/^[0-9a-f]{40}$/.test(spec)) {
      throw new GitReadError(
        `${field} must be the full 40-hex pinned revision when continuing a page (index > 0); symbolic specs such as HEAD re-resolve and may point at a different commit now — use the pinned SHA from the previous page`,
        "invalid_request",
      );
    }
  }

  /** Fails with an actionable error when the path exists in neither revision. */
  private async assertPathInEitherRevision(
    root: string,
    a: string,
    b: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const [atA, atB] = await Promise.all([
      this.run(root, ["ls-tree", a, "--", path], signal),
      this.run(root, ["ls-tree", b, "--", path], signal),
    ]);
    if (atA.code === 0 && atA.stdout.trim() !== "") return;
    if (atB.code === 0 && atB.stdout.trim() !== "") return;
    throw new GitReadError(
      `path '${path}' is not present in either revision; use action=listFiles to see what exists there`,
      "path_not_found",
    );
  }

  private acquisitionBlock(repoRoot: string, pinned: Record<string, string>, extra?: { snapshotId?: string; expiresAt?: string }): Record<string, unknown> {
    const block: Record<string, unknown> = {
      repoRoot,
      acquiredAt: new Date().toISOString(),
      pinned,
    };
    if (extra?.snapshotId) {
      block.snapshotId = extra.snapshotId;
      block.expiresAt = extra.expiresAt;
    }
    return block;
  }

  // -- log ------------------------------------------------------------------

  private async log(params: LogParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);

    // Paging (index>0) is served from the pinned snapshot: no re-resolution.
    // find may run against a fresh acquisition or a stored snapshot.
    if (params.index > 0 && !params.snapshotId) {
      throw new GitReadError("log index continuation requires the snapshotId returned by an initial acquisition", "invalid_request");
    }
    if (params.snapshotId) {
      const snapshot = this.loadSnapshot(params.snapshotId, "log");
      this.assertSameRepo(root, snapshot);
      const data = snapshot.data as LogSnapshotData;
      return params.find !== undefined
        ? this.logFindResult(snapshot, data, params.find, params.maxChars)
        : this.logPageResult(snapshot, data, params.index, params.maxChars);
    }

    // Fresh acquisition: pin every revision before any query runs.
    const pinned: Record<string, string> = {};
    if (params.from && params.to) {
      pinned.from = await pinRevision(this.config.gitPath, root, params.from, this.config.timeoutMs, signal);
      pinned.to = await pinRevision(this.config.gitPath, root, params.to, this.config.timeoutMs, signal);
    } else {
      pinned.rev = await pinRevision(this.config.gitPath, root, params.rev ?? "HEAD", this.config.timeoutMs, signal);
    }

    const rangeArg = params.from && params.to ? `${pinned.from}..${pinned.to}` : pinned.rev!;
    const filterArgs: string[] = [];
    if (params.author) filterArgs.push(`--author=${params.author}`);
    if (params.since) filterArgs.push(`--since=${params.since}`);
    if (params.until) filterArgs.push(`--until=${params.until}`);
    if (params.message) filterArgs.push("--fixed-strings", `--grep=${params.message}`);
    if (params.pickaxe) filterArgs.push(`-S${params.pickaxe}`);
    if (params.pickaxePattern) filterArgs.push(`-G${params.pickaxePattern}`);
    if (params.follow) {
      if (!params.paths || params.paths.length !== 1) {
        throw new GitReadError("log follow requires exactly one path", "invalid_request");
      }
      filterArgs.push("--follow");
    }
    if (params.firstParent) filterArgs.push("--first-parent");
    if (params.reverse) filterArgs.push("--reverse");

    // rev-list does not accept --follow or the -S/-G pickaxe filters; for
    // those queries the total is reported as unknown rather than computed
    // with a different (unfiltered) walk that would miscount.
    let totalCommits: number | null;
    if (params.follow || params.pickaxe || params.pickaxePattern) {
      totalCommits = null;
    } else {
      const countArgs = filterArgs.filter((arg) => arg !== "--follow");
      const countOut = await this.run(root, ["rev-list", "--count", rangeArg, ...countArgs, ...(params.paths ? ["--", ...params.paths] : [])], signal);
      if (countOut.code !== 0) throw this.gitFailure("log (count)", countOut);
      totalCommits = Number(countOut.stdout.trim()) || 0;
    }

    // --no-ext-diff/--no-textconv: pickaxe (-S/-G) runs diff machinery
    // internally; a configured diff program must never execute.
    const logOut = await this.run(root, [
      "log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--date=iso-strict", `--format=${LOG_FORMAT}`,
      rangeArg, ...filterArgs, "-n", String(params.limit),
      ...(params.paths ? ["--", ...params.paths] : []),
    ], signal);
    if (logOut.code !== 0) throw this.gitFailure("log", logOut);
    const entries = parseLogEntries(logOut.stdout);

    const id = this.nextSnapshotId({
      action: "log",
      repoRoot: root,
      pinned,
      rev: params.rev ?? (params.from && params.to ? `${params.from}..${params.to}` : "HEAD"),
      paths: params.paths ?? [],
      author: params.author ?? "",
      since: params.since ?? "",
      until: params.until ?? "",
      message: params.message ?? "",
      pickaxe: params.pickaxe ?? "",
      pickaxePattern: params.pickaxePattern ?? "",
      follow: params.follow,
      firstParent: params.firstParent,
      reverse: params.reverse,
      limit: params.limit,
    });
    const data: LogSnapshotData = { entries, totalCommits, limit: params.limit, query: this.logQueryDescription(params) };
    const snapshot = this.storeSnapshot(id, "log", root, pinned, data);
    return params.find !== undefined
      ? this.logFindResult(snapshot, data, params.find, params.maxChars)
      : this.logPageResult(snapshot, data, 0, params.maxChars);
  }

  private logQueryDescription(params: LogParams): string {
    const parts: string[] = [];
    if (params.from && params.to) parts.push(`range ${params.from}..${params.to}`);
    else parts.push(`rev ${params.rev ?? "HEAD"}`);
    if (params.paths?.length) parts.push(`paths [${params.paths.join(", ")}]`);
    if (params.author) parts.push(`author~${params.author}`);
    if (params.since) parts.push(`since=${params.since}`);
    if (params.until) parts.push(`until=${params.until}`);
    if (params.message) parts.push(`message~"${params.message}"`);
    if (params.pickaxe) parts.push(`pickaxe -S${params.pickaxe}`);
    if (params.pickaxePattern) parts.push(`pickaxe -G${params.pickaxePattern}`);
    if (params.follow) parts.push("follow");
    if (params.firstParent) parts.push("first-parent");
    if (params.reverse) parts.push("reverse");
    return parts.join(" · ");
  }

  private renderLogEntry(entry: LogEntry): string[] {
    const mergeNote = entry.parents.length > 1 ? ` [merge, ${entry.parents.length} parents]` : "";
    return [
      `${entry.sha}  ${entry.authorDate}  ${entry.authorName} <${entry.authorEmail}>`,
      `  ${entry.subject}${mergeNote}`,
    ];
  }

  private logPageResult(snapshot: StoredSnapshot, data: LogSnapshotData, index: number, maxChars: number): GitReadResult {
    const header = [
      `GitRead log · snapshot ${snapshot.id.slice(0, 16)}… (expires ${new Date(snapshot.expiresAt).toISOString()})`,
      `repo ${snapshot.repoRoot} · pinned ${describePinned(snapshot.pinned)}`,
      `query: ${data.query}`,
      data.totalCommits === null
        ? `acquired ${data.entries.length} (limit ${data.limit}); total not computed for follow/pickaxe queries`
        : `${data.totalCommits} matching commit(s) total · acquired ${data.entries.length} (limit ${data.limit})${data.entries.length < data.totalCommits ? " — raise limit or narrow filters to see more" : ""}`
    ];
    const items = data.entries.map((entry) => this.renderLogEntry(entry));
    const page = paginateItems(header, items, index, maxChars);
    const footer: string[] = [];
    if (page.nextIndex !== null) {
      footer.push(`nextIndex=${page.nextIndex} · continue with the same snapshotId and index=${page.nextIndex}`);
    } else {
      footer.push("end of acquired entries");
    }
    footer.push("find locates entries within this snapshot; show/diff read individual commits");
    const details: Record<string, unknown> = {
      action: "log",
      ...this.acquisitionBlock(snapshot.repoRoot, snapshot.pinned, { snapshotId: snapshot.id, expiresAt: new Date(snapshot.expiresAt).toISOString() }),
      totalCommits: data.totalCommits,
      acquiredEntries: data.entries.length,
      limit: data.limit,
      returnedRange: [index, index + page.shown],
      nextIndex: page.nextIndex,
      entries: data.entries.slice(index, index + page.shown),
    };
    return { text: `${page.text}\n${footer.join("\n")}`, details, isError: false };
  }

  private logFindResult(snapshot: StoredSnapshot, data: LogSnapshotData, find: string, maxChars: number): GitReadResult {
    const needle = find.toLowerCase();
    const matches: Array<{ index: number; snippet: string }> = [];
    data.entries.forEach((entry, i) => {
      if (matches.length >= GIT_READ_LIMITS.findMaxMatches) return;
      const haystack = `${entry.sha} ${entry.subject} ${entry.authorName} ${entry.authorEmail}`.toLowerCase();
      if (haystack.includes(needle)) {
        matches.push({ index: i, snippet: clipText(`${entry.sha}  ${entry.authorDate}  ${entry.subject}`, 160) });
      }
    });
    const header = [
      `GitRead log find '${find}' · snapshot ${snapshot.id.slice(0, 16)}…`,
      matches.length === 0
        ? "no matching entries in this snapshot"
        : `${matches.length} match(es)${matches.length >= GIT_READ_LIMITS.findMaxMatches ? ` (capped at ${GIT_READ_LIMITS.findMaxMatches})` : ""} of ${data.entries.length} acquired — read one with index=<entry index> and the same snapshotId`,
    ];
    const lines = matches.map((match) => `${match.index}: ${match.snippet}`);
    const text = clipText([...header, ...lines].join("\n"), maxChars);
    return {
      text,
      details: {
        action: "log",
        find,
        ...this.acquisitionBlock(snapshot.repoRoot, snapshot.pinned, { snapshotId: snapshot.id, expiresAt: new Date(snapshot.expiresAt).toISOString() }),
        matches,
        nextIndex: matches.length > 0 ? matches[0]!.index : null,
      },
      isError: false,
    };
  }

  // -- show -----------------------------------------------------------------

  private async show(params: ShowParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    this.requirePinnedForContinuation(params.index, params.rev, "rev");
    const sha = await pinRevision(this.config.gitPath, root, params.rev, this.config.timeoutMs, signal);
    const pinned = { rev: sha };

    const metaOut = await this.run(root, [
      "show", "-s", "--no-show-signature",
      "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1e%B",
      sha,
    ], signal);
    if (metaOut.code !== 0) throw this.gitFailure("show", metaOut);
    const [headPart, ...bodyParts] = metaOut.stdout.split("\x1e");
    const fields = headPart.trim().split("\x1f");
    if (fields.length < 9) throw new GitReadError(`unexpected git show output for ${sha}`, "git_failed");
    const parents = fields[1]!.split(" ").filter(Boolean);
    const meta = {
      sha: fields[0]!,
      parents,
      authorName: fields[2]!,
      authorEmail: fields[3]!,
      authorDate: fields[4]!,
      committerName: fields[5]!,
      committerEmail: fields[6]!,
      committerDate: fields[7]!,
      subject: fields[8]!,
      body: bodyParts.join("\x1e").replace(/\n+$/, ""),
    };

    // Diff basis: root commit vs empty tree; single parent by default; merge
    // commits require an explicit, disclosed parent choice (default first).
    let base: string;
    let basisNote: string;
    if (parents.length === 0) {
      base = EMPTY_TREE_SHA;
      basisNote = "root commit — diffed against the empty tree";
    } else if (parents.length === 1) {
      base = parents[0]!;
      basisNote = `diffed against its only parent ${base}`;
    } else {
      const parentIndex = params.parent ?? 1;
      if (parentIndex > parents.length) {
        throw new GitReadError(`show parent=${parentIndex} but this merge commit has ${parents.length} parent(s)`, "invalid_request");
      }
      base = parents[parentIndex - 1]!;
      basisNote = `merge commit with ${parents.length} parents — diffed against parent ${parentIndex} (${base}); git show's default combined view is not used, so each parent view is explicit and complete`;
    }
    if (params.parent !== undefined && parents.length < 2) {
      throw new GitReadError(`show parent=${params.parent} only applies to merge commits; this commit has ${parents.length} parent(s)`, "invalid_request");
    }

    const acquisition = this.acquisitionBlock(root, pinned);

    if (params.file !== undefined) {
      await this.assertPathInEitherRevision(root, base, sha, params.file, signal);
      const page = await runGitPagedLines(this.config.gitPath, root, ["diff", "--no-ext-diff", "--no-textconv", base, sha, "--", params.file], {
        timeoutMs: this.config.timeoutMs,
        maxBytes: this.config.commandByteCap,
        signal,
        skipLines: params.index,
        maxChars: params.maxChars,
      });
      const hunks = page.lines
        .map((line, i) => (line.startsWith("@@") ? { line: params.index + i, header: clipText(line, 200) } : undefined))
        .filter((value): value is { line: number; header: string } => value !== undefined);
      const text = [
        `GitRead show ${sha} · file ${params.file}`,
        `repo ${root} · pinned rev ${describePinned(pinned)} · ${basisNote}`,
        page.lines.length === 0 ? "(no changes to this file in that basis)" : "",
        ...page.lines,
        page.nextLine !== null ? `nextIndex=${page.nextLine} · continue with the same from/to/file and index=${page.nextLine}` : "end of patch",
      ].join("\n");
      return {
        text: clipText(text, params.maxChars + 512),
        details: {
          action: "show", file: params.file, ...acquisition,
          diffBasis: { base, note: basisNote },
          patchLinesReturned: page.lines.length,
          nextIndex: page.nextLine,
          hunks,
        },
        isError: false,
      };
    }

    // Inventory view.
    const [nameOut, numOut] = await Promise.all([
      this.run(root, ["diff", "--no-ext-diff", "--no-textconv", base, sha, "--name-status", "-z"], signal),
      this.run(root, ["diff", "--no-ext-diff", "--no-textconv", base, sha, "--numstat", "-z"], signal),
    ]);
    if (nameOut.code !== 0) throw this.gitFailure("show (inventory)", nameOut);
    if (numOut.code !== 0) throw this.gitFailure("show (numstat)", numOut);
    const files = joinInventory(nameOut.stdout, numOut.stdout, GIT_READ_LIMITS.fileInventoryCap);

    const header = [
      `GitRead show ${sha}`,
      `repo ${root} · pinned rev ${describePinned(pinned)}`,
      `author    ${meta.authorName} <${meta.authorEmail}>  ${meta.authorDate}`,
      `committer ${meta.committerName} <${meta.committerEmail}>  ${meta.committerDate}`,
      parents.length > 0 ? `parents   ${parents.join(", ")}` : "parents   (none — root commit)",
      basisNote,
    ];
    if (meta.body) header.push(`message   ${meta.subject}\n${clipText(meta.body, 2000)}`);
    else header.push(`message   ${meta.subject}`);
    const items = files.files.map((file) => [renderDiffFile(file)]);
    const page = paginateItems(header, items, params.index, params.maxChars);
    const footer: string[] = [];
    if (files.truncated) footer.push(`inventory capped at ${GIT_READ_LIMITS.fileInventoryCap} files — more may exist; narrow with file= or a smaller revision range`);
    if (page.nextIndex !== null) footer.push(`nextIndex=${page.nextIndex} · continue with index=${page.nextIndex}`);
    else footer.push("end of inventory");
    footer.push(`file="<path>" reads one file's patch; parent=N selects another merge parent (${parents.length})`);
    return {
      text: `${page.text}\n${footer.join("\n")}`,
      details: {
        action: "show", ...acquisition,
        commit: meta,
        diffBasis: { base, note: basisNote },
        filesTotal: files.files.length,
        inventoryTruncated: files.truncated,
        returnedRange: [params.index, params.index + page.shown],
        nextIndex: page.nextIndex,
        files: files.files.slice(params.index, params.index + page.shown),
      },
      isError: false,
    };
  }

  // -- diff -----------------------------------------------------------------

  private async diff(params: DiffParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    this.requirePinnedForContinuation(params.index, params.from, "from");
    this.requirePinnedForContinuation(params.index, params.to, "to");
    const from = await pinRevision(this.config.gitPath, root, params.from, this.config.timeoutMs, signal);
    const to = await pinRevision(this.config.gitPath, root, params.to, this.config.timeoutMs, signal);
    const pinned = { from, to };
    const acquisition = this.acquisitionBlock(root, pinned);

    if (params.file !== undefined) {
      await this.assertPathInEitherRevision(root, from, to, params.file, signal);
      const page = await runGitPagedLines(this.config.gitPath, root, ["diff", "--no-ext-diff", "--no-textconv", from, to, "--", params.file], {
        timeoutMs: this.config.timeoutMs,
        maxBytes: this.config.commandByteCap,
        signal,
        skipLines: params.index,
        maxChars: params.maxChars,
      });
      const hunks = page.lines
        .map((line, i) => (line.startsWith("@@") ? { line: params.index + i, header: clipText(line, 200) } : undefined))
        .filter((value): value is { line: number; header: string } => value !== undefined);
      const text = [
        `GitRead diff ${from} → ${to} · file ${params.file}`,
        `repo ${root} · pinned from ${from} · to ${to}`,
        page.lines.length === 0 ? "(no changes to this file between these revisions)" : "",
        ...page.lines,
        page.nextLine !== null ? `nextIndex=${page.nextLine} · continue with the same from/to/file and index=${page.nextLine}` : "end of patch",
      ].join("\n");
      return {
        text: clipText(text, params.maxChars + 512),
        details: {
          action: "diff", file: params.file, ...acquisition,
          patchLinesReturned: page.lines.length,
          nextIndex: page.nextLine,
          hunks,
        },
        isError: false,
      };
    }

    const [nameOut, numOut] = await Promise.all([
      this.run(root, ["diff", "--no-ext-diff", "--no-textconv", from, to, "--name-status", "-z"], signal),
      this.run(root, ["diff", "--no-ext-diff", "--no-textconv", from, to, "--numstat", "-z"], signal),
    ]);
    if (nameOut.code !== 0) throw this.gitFailure("diff (inventory)", nameOut);
    if (numOut.code !== 0) throw this.gitFailure("diff (numstat)", numOut);
    const files = joinInventory(nameOut.stdout, numOut.stdout, GIT_READ_LIMITS.fileInventoryCap);

    const header = [
      `GitRead diff ${from} → ${to}`,
      `repo ${root} · pinned from ${from} · to ${to}`,
      `${files.files.length} file(s) listed${files.truncated ? ` (capped at ${GIT_READ_LIMITS.fileInventoryCap}; more may exist)` : ""}`,
    ];
    const items = files.files.map((file) => [renderDiffFile(file)]);
    const page = paginateItems(header, items, params.index, params.maxChars);
    const footer: string[] = [];
    if (page.nextIndex !== null) footer.push(`nextIndex=${page.nextIndex} · continue with index=${page.nextIndex}`);
    else footer.push("end of inventory");
    footer.push('file="<path>" reads one file\'s patch page; the inventory is complete only up to the stated cap');
    return {
      text: `${page.text}\n${footer.join("\n")}`,
      details: {
        action: "diff", ...acquisition,
        filesTotal: files.files.length,
        inventoryTruncated: files.truncated,
        returnedRange: [params.index, params.index + page.shown],
        nextIndex: page.nextIndex,
        files: files.files.slice(params.index, params.index + page.shown),
      },
      isError: false,
    };
  }

  // -- blame ----------------------------------------------------------------

  private async blame(params: BlameParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    this.requirePinnedForContinuation(params.index, params.rev, "rev");
    const sha = await pinRevision(this.config.gitPath, root, params.rev, this.config.timeoutMs, signal);
    const pinned = { rev: sha };

    // Windowed blame: the line window is the work bound. `index` is a zero-based
    // line offset (resume from line index+1); startLine/endLine constrain the
    // window. Continuation passes the returned nextIndex back as `index`, so
    // paging stays exact without re-deriving ranges.
    const resumeAt = params.index + 1;
    if (params.endLine !== undefined && params.endLine < resumeAt) {
      throw new GitReadError(`blame index ${params.index} is past the requested line window (ends at line ${params.endLine})`, "invalid_request");
    }
    const start = Math.max(resumeAt, params.startLine ?? 1);
    const end = Math.min(params.endLine ?? Number.MAX_SAFE_INTEGER, start + GIT_READ_LIMITS.blameMaxLinesPerCall - 1);

    const out = await this.run(root, ["blame", "--porcelain", "-L", `${start},${end}`, sha, "--", params.path], signal);
    if (out.code !== 0) {
      // A window that starts past the end of the file is a clean end-of-file,
      // not an error: git reports `fatal: file <path> has only N lines`.
      if (/has only \d+ lines/i.test(out.stderr)) {
        return {
          text: [
            `GitRead blame ${params.path} @ ${sha}`,
            `repo ${root} · pinned rev ${describePinned(pinned)} · window lines ${start}-${end} (past end of file)`,
            "0 ownership range(s) in window",
            "end of file",
          ].join("\n"),
          details: { action: "blame", path: params.path, ...this.acquisitionBlock(root, pinned), window: [start, end], rangesTotal: 0, nextIndex: null, ranges: [] },
          isError: false,
        };
      }
      throw this.gitFailure("blame", out);
    }
    const lines = parseBlamePorcelain(out.stdout);

    // Aggregate consecutive lines owned by the same commit.
    const ranges: Array<{ startLine: number; endLine: number; commit: string; author: string; authorDate: string; summary: string }> = [];
    for (const record of lines) {
      const last = ranges[ranges.length - 1];
      if (last && last.commit === record.commit && last.endLine + 1 === record.line) {
        last.endLine = record.line;
      } else {
        ranges.push({ startLine: record.line, endLine: record.line, commit: record.commit, author: record.author, authorDate: record.authorDate, summary: record.summary });
      }
    }

    const windowEnd = lines.length > 0 ? start + lines.length - 1 : start;
    const header = [
      `GitRead blame ${params.path} @ ${sha}`,
      `repo ${root} · pinned rev ${describePinned(pinned)} · window lines ${start}-${windowEnd}${lines.length === 0 ? " (no lines — the file may end before this window)" : ""}`,
      `${ranges.length} ownership range(s) in window`,
    ];
    const items = ranges.map((range) => [
      `L${range.startLine}${range.endLine > range.startLine ? `-${range.endLine}` : ""}  ${range.commit}  ${range.authorDate}  ${range.author}`,
      `  ${clipText(range.summary, 160)}`,
    ]);
    const page = paginateItems(header, items, 0, params.maxChars);
    const windowFull = lines.length > 0 && lines[lines.length - 1]!.line === end;
    // The requested window is fully served only when it was unbounded or when
    // the per-call cap did not cut it short: `end` is the last line this page
    // could cover, so `end < endLine` means the model asked for lines beyond
    // the cap. A continuation at `index = end` is accepted by the guard above
    // (resumeAt = end + 1 <= endLine), and when the file really ends at `end`
    // the continuation returns the clean past-EOF page.
    const windowIncomplete = params.endLine === undefined || end < params.endLine;
    let nextIndex: number | null;
    if (page.nextIndex !== null) {
      // More ranges remain in this window: resume at the next range's first line.
      nextIndex = ranges[page.nextIndex]!.startLine - 1;
    } else if (windowFull && windowIncomplete) {
      nextIndex = end;
    } else {
      nextIndex = null; // the requested window (or the file) ends here
    }
    const footer = nextIndex !== null
      ? [`nextIndex=${nextIndex} · continue with index=${nextIndex}`]
      : ["end of file"];
    return {
      text: `${page.text}\n${footer.join("\n")}`,
      details: {
        action: "blame", path: params.path, ...this.acquisitionBlock(root, pinned),
        window: [start, windowEnd],
        rangesTotal: ranges.length,
        nextIndex,
        ranges,
      },
      isError: false,
    };
  }

  // -- refs -----------------------------------------------------------------

  private async refs(params: RefsParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    if (params.snapshotId) {
      const snapshot = this.loadSnapshot(params.snapshotId, "refs");
      this.assertSameRepo(root, snapshot);
      const data = snapshot.data as RefsSnapshotData;
      return params.find !== undefined
        ? this.listFindResult(snapshot, data.refs.map((ref) => ref.refname), params.find, params.maxChars, "refs")
        : this.listPageResult(snapshot, data.refs.map((ref) => [
          `${ref.refname}  ${ref.type}  ${ref.sha}${ref.peeledSha ? ` → ${ref.peeledSha}` : ""}${ref.committerDate ? `  ${ref.committerDate}` : ""}`,
        ]), params.index, params.maxChars, {
          header: [
            `GitRead refs · snapshot ${snapshot.id.slice(0, 16)}… (expires ${new Date(snapshot.expiresAt).toISOString()})`,
            `repo ${snapshot.repoRoot} · ${data.refs.length} ref(s) listed${data.truncated ? " (capped)" : ""}${data.pattern ? ` · acquired pattern '${data.pattern}'` : " · all refs"}`,
          ],
          details: { refs: data.refs },
        });
    }

    const args = ["for-each-ref", "--count", String(GIT_READ_LIMITS.refsCap + 1), "--format=%(refname)%09%(objecttype)%09%(objectname)%09%(*objectname)%09%(committerdate:iso-strict)"];
    if (params.pattern) args.push(params.pattern);
    const out = await this.run(root, args, signal);
    if (out.code !== 0) throw this.gitFailure("refs", out);
    const refs = parseForEachRef(out.stdout);
    const truncated = refs.length > GIT_READ_LIMITS.refsCap;
    const kept = refs.slice(0, GIT_READ_LIMITS.refsCap);

    const id = this.nextSnapshotId({ action: "refs", repoRoot: root, pattern: params.pattern ?? "" });
    const data: RefsSnapshotData = { refs: kept, truncated, pattern: params.pattern };
    const snapshot = this.storeSnapshot(id, "refs", root, {}, data);
    return params.find !== undefined
      ? this.listFindResult(snapshot, kept.map((ref) => ref.refname), params.find, params.maxChars, "refs")
      : this.listPageResult(snapshot, kept.map((ref) => [
        `${ref.refname}  ${ref.type}  ${ref.sha}${ref.peeledSha ? ` → ${ref.peeledSha}` : ""}${ref.committerDate ? `  ${ref.committerDate}` : ""}`,
      ]), 0, params.maxChars, {
        header: [
          `GitRead refs · snapshot ${snapshot.id.slice(0, 16)}… (expires ${new Date(snapshot.expiresAt).toISOString()})`,
          `repo ${root} · ${kept.length} ref(s) listed${truncated ? ` (capped at ${GIT_READ_LIMITS.refsCap}; more may exist)` : ""}${params.pattern ? ` · pattern '${params.pattern}'` : ""}`,
        ],
        details: { refs: kept },
      });
  }

  // -- mergeBase ------------------------------------------------------------

  private async mergeBase(params: MergeBaseParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    const a = await pinRevision(this.config.gitPath, root, params.a, this.config.timeoutMs, signal);
    const b = await pinRevision(this.config.gitPath, root, params.b, this.config.timeoutMs, signal);
    const out = await this.run(root, ["merge-base", a, b], signal);
    if (out.code === 0) {
      const sha = out.stdout.trim();
      return {
        text: `GitRead mergeBase · ${a} and ${b} diverge from common ancestor ${sha}`,
        details: { action: "mergeBase", ...this.acquisitionBlock(root, { a, b }), mergeBase: sha },
        isError: false,
      };
    }
    if (out.code === 1 && out.stdout.trim() === "" && out.stderr.trim() === "") {
      return {
        text: `GitRead mergeBase · ${a} and ${b} have no common ancestor (unrelated histories)`,
        details: { action: "mergeBase", ...this.acquisitionBlock(root, { a, b }), mergeBase: null },
        isError: false,
      };
    }
    throw this.gitFailure("merge-base", out);
  }

  // -- listFiles ------------------------------------------------------------

  private async listFiles(params: ListFilesParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    if (params.snapshotId) {
      const snapshot = this.loadSnapshot(params.snapshotId, "listFiles");
      // repo already resolved above; assertSameRepo below the load.
      this.assertSameRepo(root, snapshot);
      const data = snapshot.data as ListFilesSnapshotData;
      return params.find !== undefined
        ? this.listFindResult(snapshot, data.files.map((file) => file.path), params.find, params.maxChars, "listFiles")
        : this.listPageResult(snapshot, data.files.map((file) => [renderTreeFile(file)]), params.index, params.maxChars, {
          header: [
            `GitRead listFiles · snapshot ${snapshot.id.slice(0, 16)}… (expires ${new Date(snapshot.expiresAt).toISOString()})`,
            `repo ${snapshot.repoRoot} · pinned rev ${describePinned(snapshot.pinned)} · ${data.files.length} entr(y/ies) listed${data.truncated ? " (capped)" : ""}${data.paths?.length ? ` · acquired paths [${data.paths.join(", ")}]` : " · all tracked files"}`,
          ],
          details: { files: data.files },
        });
    }

    const sha = await pinRevision(this.config.gitPath, root, params.rev, this.config.timeoutMs, signal);
    const pinned = { rev: sha };
    const out = await this.run(root, ["ls-tree", "-r", "-l", "-z", sha, ...(params.paths ? ["--", ...params.paths] : [])], signal);
    if (out.code !== 0) throw this.gitFailure("listFiles", out);
    const files = parseLsTreeZ(out.stdout);
    const truncated = files.length > GIT_READ_LIMITS.listFilesCap;
    const kept = files.slice(0, GIT_READ_LIMITS.listFilesCap);

    const id = this.nextSnapshotId({ action: "listFiles", repoRoot: root, pinned, rev: params.rev, paths: params.paths ?? [] });
    const data: ListFilesSnapshotData = { files: kept, truncated, paths: params.paths };
    const snapshot = this.storeSnapshot(id, "listFiles", root, pinned, data);
    return params.find !== undefined
      ? this.listFindResult(snapshot, kept.map((file) => file.path), params.find, params.maxChars, "listFiles")
      : this.listPageResult(snapshot, kept.map((file) => [renderTreeFile(file)]), 0, params.maxChars, {
        header: [
          `GitRead listFiles · snapshot ${snapshot.id.slice(0, 16)}… (expires ${new Date(snapshot.expiresAt).toISOString()})`,
          `repo ${root} · pinned rev ${describePinned(pinned)} · ${kept.length} entr(y/ies) listed${truncated ? ` (capped at ${GIT_READ_LIMITS.listFilesCap}; more may exist)` : ""}`,
        ],
        details: { files: kept },
      });
  }

  // -- readFile -------------------------------------------------------------

  private async readFile(params: ReadFileParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    this.requirePinnedForContinuation(params.index, params.rev, "rev");
    const sha = await pinRevision(this.config.gitPath, root, params.rev, this.config.timeoutMs, signal);
    const pinned = { rev: sha };
    const acquisition = this.acquisitionBlock(root, pinned);

    // -z keeps the NUL-record contract parseLsTreeZ expects (the path field
    // must not carry a trailing newline).
    const lsOut = await this.run(root, ["ls-tree", "-l", "-z", sha, "--", params.path], signal);
    if (lsOut.code !== 0) throw this.gitFailure("readFile (ls-tree)", lsOut);
    const entries = parseLsTreeZ(lsOut.stdout);
    if (entries.length === 0) {
      throw new GitReadError(`path '${params.path}' is not tracked at revision ${sha}; use action=listFiles to see what exists there`, "path_not_found");
    }
    const entry = entries[0]!;
    if (entry.type === "tree") {
      throw new GitReadError(`path '${params.path}' is a directory at revision ${sha}; use action=listFiles with paths=['${params.path}']`, "path_is_directory");
    }
    if (entry.type === "commit") {
      throw new GitReadError(`path '${params.path}' is a submodule reference at revision ${sha}; its content lives in another repository and is not readable here`, "path_is_submodule");
    }

    const tooLarge = (entry.size ?? 0) > GIT_READ_LIMITS.readFileMaxBytes;
    if (tooLarge) {
      // Bounded binary probe: stream at most readFileProbeBytes of the raw
      // blob, kill the child at the cap, and never buffer the full over-cap
      // blob. A NUL byte anywhere in the probed prefix marks binary content.
      // The probe must never depend on the blob fitting the cap (the old
      // cat-file -p probe always tripped it and could never detect binary).
      const probeBytes = GIT_READ_LIMITS.readFileProbeBytes;
      let binary = false;
      let probed = false;
      let probeError: string | undefined;
      try {
        const probe = await runGitBytePrefix(this.config.gitPath, root, ["cat-file", "blob", entry.sha], {
          timeoutMs: this.config.timeoutMs,
          maxBytes: probeBytes,
          signal,
        });
        // Judge the probe by observed bytes, never by assumed success: an
        // over-cap blob always yields a non-empty prefix when the probe ran.
        probed = probe.bytes.length > 0;
        binary = probed && probe.bytes.includes(0);
      } catch (error) {
        if (error instanceof GitReadError && error.code === "aborted") throw error;
        // Probe failure (timeout/spawn) is disclosed, never guessed: binary
        // stays false with binaryProbed=false plus the reason.
        probeError = error instanceof Error ? error.message : String(error);
      }
      return {
        text: [
          `GitRead readFile ${params.path} @ ${sha}`,
          `repo ${root} · pinned rev ${describePinned(pinned)}`,
          `file is ${shortBytes(entry.size)} — larger than the ${shortBytes(GIT_READ_LIMITS.readFileMaxBytes)} read cap; content not returned${probed && binary ? ` (binary content detected in the first ${shortBytes(probeBytes)})` : probed ? ` (first ${shortBytes(probeBytes)} probed, no binary marker)` : ` (binary probe failed${probeError ? `: ${clipText(probeError, 200)}` : ""})`}`,
          "use diff/show patch views or search to inspect specific parts instead",
        ].join("\n"),
        details: {
          action: "readFile", path: params.path, ...acquisition,
          blobSha: entry.sha, size: entry.size, binary, truncated: true,
          binaryProbed: probed,
          ...(probed ? { binaryProbeBytes: probeBytes } : {}),
          ...(probeError ? { binaryProbeError: probeError } : {}),
        },
        isError: false,
      };
    }

    const out = await this.run(root, ["cat-file", "-p", entry.sha], signal);
    if (out.code !== 0) throw this.gitFailure("readFile (cat-file)", out);
    const content = out.stdout;
    // The whole content is already buffered (≤ readFileMaxBytes): scan all of
    // it for NUL. A first-8000-bytes-only check leaks binary past byte 8000
    // as model-facing "text".
    if (content.includes("\u0000")) {
      return {
        text: [
          `GitRead readFile ${params.path} @ ${sha}`,
          `repo ${root} · pinned rev ${describePinned(pinned)}`,
          `file is binary (${shortBytes(entry.size)}); content not returned`,
        ].join("\n"),
        details: { action: "readFile", path: params.path, ...acquisition, blobSha: entry.sha, size: entry.size, binary: true },
        isError: false,
      };
    }

    const allLines = content.split("\n");
    // A trailing newline terminates the last line; it is not an extra line.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
    const lines = allLines.slice(params.index);
    let text = "";
    let shown = 0;
    for (const line of lines) {
      const candidate = text === "" ? line : `${text}\n${line}`;
      if (candidate.length > params.maxChars && shown > 0) break;
      text = candidate;
      shown += 1;
    }
    const nextIndex = params.index + shown < allLines.length ? params.index + shown : null;
    return {
      text: [
        `GitRead readFile ${params.path} @ ${sha}`,
        `repo ${root} · pinned rev ${describePinned(pinned)} · ${shortBytes(entry.size)} blob ${entry.sha}`,
        `lines ${params.index + 1}-${params.index + shown} of ${allLines.length}`,
        text,
        nextIndex !== null ? `nextIndex=${nextIndex} · continue with index=${nextIndex}` : "end of file",
      ].join("\n"),
      details: { action: "readFile", path: params.path, ...acquisition, blobSha: entry.sha, size: entry.size, binary: false, totalLines: allLines.length, nextIndex },
      isError: false,
    };
  }

  // -- search ---------------------------------------------------------------

  private async search(params: SearchParams, signal?: AbortSignal): Promise<GitReadResult> {
    const root = await this.repo(signal);
    if (params.snapshotId) {
      const snapshot = this.loadSnapshot(params.snapshotId, "search");
      // repo already resolved above; assertSameRepo below the load.
      this.assertSameRepo(root, snapshot);
      const data = snapshot.data as SearchSnapshotData;
      return params.find !== undefined
        ? this.listFindResult(snapshot, data.matches.map((match) => `${match.path}:${match.line}`), params.find, params.maxChars, "search")
        : this.listPageResult(snapshot, data.matches.map((match) => [renderSearchMatch(match)]), params.index, params.maxChars, {
          header: [
            `GitRead search · snapshot ${snapshot.id.slice(0, 16)}… (expires ${new Date(snapshot.expiresAt).toISOString()})`,
            `acquired query: '${data.pattern}'${data.fixedStrings ? " (literal)" : " (regex)"}${data.caseInsensitive ? " · case-insensitive" : ""} @ ${describePinned(snapshot.pinned)}`,
            `${data.matches.length} match(es)${data.truncated ? " (capped)" : ""}`,
          ],
          details: { matches: data.matches },
        });
    }

    const sha = await pinRevision(this.config.gitPath, root, params.rev, this.config.timeoutMs, signal);
    const pinned = { rev: sha };
    // -z makes the record layout structural (see parseGrepLines): NUL
    // separates <rev>:<path>, the line number, and the matched text.
    const args = ["grep", "-n", "-I", "-z"];
    if (params.caseInsensitive) args.push("-i");
    if (params.fixedStrings) args.push("-F");
    args.push(`-e${params.pattern}`, sha, ...(params.paths ? ["--", ...params.paths] : []));
    const out = await this.run(root, args, signal);
    if (out.code !== 0 && out.code !== 1) throw this.gitFailure("search", out); // exit 1 = no matches
    let matches = parseGrepLines(out.stdout, sha);
    const truncated = matches.length > GIT_READ_LIMITS.searchMatchCap;
    matches = matches.slice(0, GIT_READ_LIMITS.searchMatchCap).map((match) => ({
      ...match,
      text: match.text.length > 400 ? `${match.text.slice(0, 400)}…` : match.text,
      textTruncated: match.text.length > 400,
    }));

    const id = this.nextSnapshotId({
      action: "search", repoRoot: root, pinned, rev: params.rev, pattern: params.pattern,
      paths: params.paths ?? [], fixedStrings: params.fixedStrings, caseInsensitive: params.caseInsensitive,
    });
    const data: SearchSnapshotData = { matches, truncated, pattern: params.pattern, fixedStrings: params.fixedStrings, caseInsensitive: params.caseInsensitive };
    const snapshot = this.storeSnapshot(id, "search", root, pinned, data);
    return params.find !== undefined
      ? this.listFindResult(snapshot, matches.map((match) => `${match.path}:${match.line}`), params.find, params.maxChars, "search")
      : this.listPageResult(snapshot, matches.map((match) => [renderSearchMatch(match)]), 0, params.maxChars, {
        header: [
          `GitRead search '${params.pattern}'${params.fixedStrings ? " (literal)" : " (regex)"} @ ${sha}${params.caseInsensitive ? " · case-insensitive" : ""}`,
          `repo ${root} · pinned rev ${describePinned(pinned)} · ${matches.length} match(es)${truncated ? ` (capped at ${GIT_READ_LIMITS.searchMatchCap}; more may exist)` : ""}`,
        ],
        details: { matches },
      });
  }

  // -- shared list rendering --------------------------------------------------

  private listPageResult(
    snapshot: StoredSnapshot,
    items: ReadonlyArray<ReadonlyArray<string>>,
    index: number,
    maxChars: number,
    context: { header: string[]; details: Record<string, unknown> },
  ): GitReadResult {
    const page = paginateItems(context.header, items, index, maxChars);
    const footer = page.nextIndex !== null
      ? [`nextIndex=${page.nextIndex} · continue with the same snapshotId and index=${page.nextIndex}`]
      : ["end of list"];
    return {
      text: `${page.text}\n${footer.join("\n")}`,
      details: {
        action: snapshot.action,
        ...this.acquisitionBlock(snapshot.repoRoot, snapshot.pinned, { snapshotId: snapshot.id, expiresAt: new Date(snapshot.expiresAt).toISOString() }),
        returnedRange: [index, index + page.shown],
        nextIndex: page.nextIndex,
        totalEntries: items.length,
        ...context.details,
      },
      isError: false,
    };
  }

  private listFindResult(
    snapshot: StoredSnapshot,
    needles: string[],
    find: string,
    maxChars: number,
    action: string,
  ): GitReadResult {
    const needle = find.toLowerCase();
    const matches: Array<{ index: number; snippet: string }> = [];
    needles.forEach((value, i) => {
      if (matches.length >= GIT_READ_LIMITS.findMaxMatches) return;
      if (value.toLowerCase().includes(needle)) matches.push({ index: i, snippet: clipText(value, 160) });
    });
    const header = [
      `GitRead ${action} find '${find}' · snapshot ${snapshot.id.slice(0, 16)}…`,
      matches.length === 0
        ? "no matching entries in this snapshot"
        : `${matches.length} match(es)${matches.length >= GIT_READ_LIMITS.findMaxMatches ? ` (capped at ${GIT_READ_LIMITS.findMaxMatches})` : ""} of ${needles.length} — read one with index=<entry index> and the same snapshotId`,
    ];
    const lines = matches.map((match) => `${match.index}: ${match.snippet}`);
    return {
      text: clipText([...header, ...lines].join("\n"), maxChars),
      details: {
        action,
        find,
        ...this.acquisitionBlock(snapshot.repoRoot, snapshot.pinned, { snapshotId: snapshot.id, expiresAt: new Date(snapshot.expiresAt).toISOString() }),
        matches,
        nextIndex: matches.length > 0 ? matches[0]!.index : null,
      },
      isError: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Shared renderers and the status rationale
// ---------------------------------------------------------------------------

function describePinned(pinned: Record<string, string>): string {
  const parts = Object.entries(pinned).map(([role, sha]) => `${role}=${sha}`);
  return parts.length > 0 ? parts.join(" · ") : "none";
}

function renderDiffFile(file: DiffFileEntry): string {
  const stats = file.binary
    ? "binary"
    : `+${file.added ?? "?"} −${file.removed ?? "?"}`;
  const rename = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return `${file.status.padEnd(6)} ${rename}  ${stats}`;
}

function renderTreeFile(file: TreeFileEntry): string {
  const size = file.type === "blob" ? `  ${shortBytes(file.size)}` : "";
  return `${file.mode} ${file.type}${size}  ${file.path}`;
}

function renderSearchMatch(match: SearchMatch): string {
  return `${match.path}:${match.line}: ${clipText(match.text, 400)}${match.textTruncated ? "…" : ""}`;
}

/** Joins separate --name-status/-z and --numstat/-z outputs into one inventory. */
function joinInventory(nameStatusOut: string, numstatOut: string, cap: number): InventorySnapshotData {
  const nameEntries = parseNameStatusZ(nameStatusOut);
  const stats = parseNumstatZ(numstatOut);
  const files: DiffFileEntry[] = [];
  for (const entry of nameEntries) {
    if (files.length >= cap) break;
    const key = entry.oldPath !== undefined ? `${entry.oldPath}\u0000${entry.path}` : entry.path;
    const stat = stats.get(key);
    files.push({
      status: entry.status,
      path: entry.path,
      ...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
      added: stat?.added ?? null,
      removed: stat?.removed ?? null,
      binary: stat !== undefined && (stat.added === null || stat.removed === null),
    });
  }
  return { files, truncated: nameEntries.length > cap };
}

function statusUnsupportedResult(): GitReadResult {
  const text = [
    "status is explicitly unsupported by GitRead in this release (worktree-diff likewise).",
    "Rationale: worktree reads cannot guarantee that configured clean/textconv/attribute programs or fsmonitor side effects are prevented across all Git versions, and a single-pass worktree read is non-atomic — the index and files can change mid-read, so it cannot be presented as a stable snapshot.",
    "Use historical (stored-object) operations instead: diff with two explicit revisions (e.g. from=HEAD~1 to=HEAD or branch tips), show, log, listFiles, readFile at a revision.",
    "Future work: a labeled single-pass status snapshot if filter/fsmonitor prevention can be proven for the supported Git versions.",
  ].join("\n");
  return {
    text,
    details: { action: "status", supported: false, reason: "worktree operations are unsupported by design (fail closed)" },
    isError: true,
  };
}

function failureResult(error: unknown): GitReadResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    text: `GitRead failed: ${message}`,
    details: { error: message, ...(error instanceof GitReadError ? { code: error.code } : {}) },
    isError: true,
  };
}
