import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  NativeSessionSdkInfo,
  resolveNativeSessionSdk,
} from "./native-session-sdk";

/**
 * Read-only native saved-conversation catalog and deliberate per-child resume
 * admission (issue 323).
 *
 * This module lists the normal shared native agent root's saved conversations
 * through the Pi package's PUBLIC SDK surface only:
 *
 * - Top-level discovery of `<agentDir>/sessions` project directories uses
 *   dirents + lstat and prunes `.terraform` BEFORE any descent; directory
 *   symlinks are never followed. Only approved real project session
 *   directories are enumerated.
 * - Each approved directory is listed with the public
 *   `SessionManager.listAll(EXPLICIT projectDir, progress?, AbortSignal)`
 *   flat-directory overload (the SDK's flat list filters `.jsonl` and does
 *   not recurse). The no-arg scan (which follows symlinks) and the
 *   cwd-filtering `list` are never used.
 * - The catalog is strictly read-only user storage: no SDK
 *   `SessionManager.open`/create/migrate, no credential reads, no provider
 *   activation, no user filesystem mutation. Unknown or malformed files and
 *   directories are preserved untouched; a missing sessions root is an
 *   honest empty catalog.
 * - Rows carry observed id/file/cwd plus the canonical display caption only —
 *   never transcripts, last messages, tool lists, or question text. The
 *   caption is display-limited (256 codepoints) and is not a rename prefill
 *   or the full stored name.
 * - Admission is deliberate and fail-closed: it validates the exact catalog
 *   row against the live file (regular, non-symlink, dev/ino identity,
 *   first-line header id/cwd), refuses stale catalogs, foreign rows, replaced
 *   files, unavailable workspaces, and caller-reported known-owned duplicates.
 *   There is no automatic latest-session resume or fallback, no live-process
 *   detection, and no locking: the API caller supplies its owned live native
 *   session ids/files when it wants the duplicate guard.
 * - The admission receipt is an ephemeral branded object; the root launch
 *   (src/session-host/launch.ts) revalidates it against the accepted native
 *   agent directory and file identity BEFORE spawn.
 */

/** Directory name holding the native saved conversations under the agent root. */
export const SAVED_SESSIONS_DIRNAME = "sessions";

/** Pruned before any descent, at every discovery level (see AGENTS.md search safety). */
const TERRAFORM_DIRNAME = ".terraform";

/** Canonical display caption limit in Unicode codepoints (display only, not rename prefill). */
export const MAX_SAVED_SESSION_CAPTION_CODEPOINTS = 256;

/** Fallback caption when a saved conversation has no persisted name and no first message. */
export const NO_MESSAGES_CAPTION = "(no messages)";

/** Bounded concurrency for per-project-directory SDK listing. */
const MAX_PROJECT_LIST_CONCURRENCY = 4;

/** Bounded number of catalog issues retained (the total is always reported). */
const MAX_CATALOG_ISSUES = 20;

/** Upper bound for the bounded first-line session header read (never a whole transcript). */
export const MAX_SESSION_HEADER_BYTES = 64 * 1024;

/** One observed saved conversation row: identity and display metadata only. */
export interface SavedSessionRow {
  /** SDK session ID (first-line header id). */
  id: string;
  /** Canonical absolute path of the saved conversation JSONL file. */
  file: string;
  /** Session working directory recorded in the file header. */
  cwd: string;
  /** Canonical display caption (256-codepoint limit; not the full stored name). */
  caption: string;
  /** Project session directory containing the file. */
  projectDir: string;
  createdAt?: Date;
  modifiedAt?: Date;
}

/** One bounded, content-free catalog issue (malformed entry, failed listing, …). */
export interface SavedSessionIssue {
  projectDir: string;
  reason: string;
}

/** A read-only snapshot of one native agent root's saved conversations. */
export interface SavedSessionCatalog {
  /** Canonical native agent directory the catalog was listed from. */
  agentDir: string;
  /** Canonical sessions root (`<agentDir>/sessions`). */
  sessionsRoot: string;
  /** Query revision for this agent directory (stale catalogs cannot mint admissions). */
  revision: number;
  rows: SavedSessionRow[];
  /** Bounded retained issues (first {@link MAX_CATALOG_ISSUES}). */
  issues: SavedSessionIssue[];
  /** Total issue count, including any beyond the retained bound. */
  issueCount: number;
}

/** An ephemeral branded admission receipt for one exact saved conversation file. */
export interface SavedSessionAdmission {
  /** Canonical native agent directory the admission was minted under. */
  agentDir: string;
  /** Exact canonical path of the admitted saved conversation JSONL file. */
  file: string;
  /** Session ID verified against the file's first-line header. */
  sessionId: string;
  /** Working directory exactly as recorded in the file's first-line header. */
  cwd: string;
  /** Canonical workspace verified from the header cwd at admission time. */
  workspace: string;
  /** File identity observed when the catalog row was minted (safe bigint dev/ino). */
  dev: bigint;
  ino: bigint;
}

/** Fail-closed refusal reasons for saved-session admission. */
export type SavedSessionRefusalReason =
  | "stale-catalog"
  | "unknown-row"
  | "missing-file"
  | "not-a-regular-file"
  | "symlink-file"
  | "outside-sessions-root"
  | "replaced-file"
  | "malformed-header"
  | "workspace-unavailable"
  | "known-owned-duplicate";

export type SavedSessionAdmissionResult =
  | { status: "admitted"; admission: SavedSessionAdmission }
  | { status: "refused"; reason: SavedSessionRefusalReason };

/** Caller-supplied owned live native session (data supplied by the caller; no PID scan). */
export interface OwnedLiveSession {
  /** Live native session ID. */
  id?: string;
  /** Live native session file path. */
  file?: string;
}

export interface AdmitSavedSessionOptions {
  /**
   * The API caller's OWN live native sessions, supplied as data: a row whose
   * id or canonical file matches an entry is refused as a known-owned
   * duplicate. No external process discovery happens here.
   */
  ownedLiveSessions?: readonly OwnedLiveSession[];
}

export interface ListSavedSessionsOptions {
  /** Native agent directory to catalog (absolute). */
  agentDir: string;
  /**
   * Resolved native Pi CLI used to locate the public SDK of its own official
   * package. Required unless `listAll` is injected.
   */
  piExecutable?: string;
  /**
   * Public API injection for component tests: the explicit flat-directory
   * `listAll(sessionDir, onProgress?, signal?)` implementation. When present,
   * no SDK resolution or loading happens.
   */
  listAll?: (
    sessionDir: string,
    onProgress?: (progress: Readonly<Record<string, unknown>>) => void,
    signal?: AbortSignal,
  ) => Promise<NativeSessionSdkInfo[]>;
  /** Abort the listing; late completions of an aborted query never contribute. */
  signal?: AbortSignal;
}

const catalogBrand = new WeakSet<object>();
const admissionBrand = new WeakSet<object>();
/**
 * Authoritative file identity observed when each row was minted (safe bigint
 * dev/ino). Kept outside the mutable row objects so a caller can never
 * retarget a row's identity; rows themselves are deeply frozen at mint time.
 */
const rowIdentity = new WeakMap<SavedSessionRow, { dev: bigint; ino: bigint }>();

/** True only for catalogs minted by listSavedSessions (never caller-fabricated). */
export function isSavedSessionCatalog(value: unknown): value is SavedSessionCatalog {
  return typeof value === "object" && value !== null && catalogBrand.has(value);
}

/** True only for admission receipts minted by admitSavedSession. */
export function isSavedSessionAdmission(value: unknown): value is SavedSessionAdmission {
  return typeof value === "object" && value !== null && admissionBrand.has(value);
}

/** Per-agent-directory query revision: a newer list supersedes older catalogs. */
const catalogRevisions = new Map<string, number>();

function nextCatalogRevision(agentDir: string): number {
  const revision = (catalogRevisions.get(agentDir) ?? 0) + 1;
  catalogRevisions.set(agentDir, revision);
  return revision;
}

/**
 * Canonical display caption: the persisted name when present and nonblank,
 * else the first user message text, else "(no messages)". Control characters
 * are replaced with spaces, and the result is limited to 256 codepoints
 * (ellipsis-truncated). This is a display caption only — never a rename
 * prefill or the full stored name.
 */
export function canonicalSavedSessionCaption(
  name: string | undefined,
  firstMessage: string | undefined,
): string {
  const trimmed = (value: string | undefined): string | null => {
    if (typeof value !== "string") return null;
    const t = value.trim();
    return t.length > 0 ? t : null;
  };
  const source = trimmed(name) ?? trimmed(firstMessage);
  if (source === null) return NO_MESSAGES_CAPTION;
  const sanitized = source.replace(/[\u0000-\u001f\u007f]/g, " ");
  const codepoints = Array.from(sanitized);
  if (codepoints.length <= MAX_SAVED_SESSION_CAPTION_CODEPOINTS) return codepoints.join("");
  return `${codepoints.slice(0, MAX_SAVED_SESSION_CAPTION_CODEPOINTS - 1).join("")}\u2026`;
}

/** Bounded first-line read of a saved conversation's public session header. */
export function readSavedSessionHeader(file: string): { id: string; cwd: string } | undefined {
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined; // special file: never probe it
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    let offset = 0;
    let lineEnd = -1;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      lineEnd = buffer.subarray(0, offset).indexOf(0x0a);
      if (lineEnd !== -1) break;
    }
    const firstLine = (lineEnd === -1 ? buffer.subarray(0, offset) : buffer.subarray(0, lineEnd)).toString("utf8");
    if (firstLine.trim().length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.length === 0) return undefined;
    if (typeof record.cwd !== "string" || record.cwd.length === 0) return undefined;
    return { id: record.id, cwd: record.cwd };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask the bounded header read result.
    }
  }
}

function isExistingDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** Canonicalize a path for identity comparison without following a missing target. */
function canonicalizePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("saved-session listing aborted");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * Top-level discovery of approved real project session directories under the
 * sessions root: dirents + lstat only, `.terraform` pruned BEFORE any
 * descent, directory symlinks never followed. Unknown files and directories
 * are preserved (never touched); only real directories become listing targets.
 */
function discoverProjectSessionDirs(
  sessionsRoot: string,
): { projectDirs: string[]; issues: SavedSessionIssue[] } {
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return { projectDirs: [], issues: [{ projectDir: sessionsRoot, reason: "sessions root could not be read" }] };
  }
  const projectDirs: string[] = [];
  const issues: SavedSessionIssue[] = [];
  for (const entry of entries) {
    if (entry.name === TERRAFORM_DIRNAME) continue; // pruned before any descent
    const full = join(sessionsRoot, entry.name);
    let stats;
    try {
      stats = lstatSync(full);
    } catch {
      issues.push({ projectDir: full, reason: "entry could not be inspected" });
      continue;
    }
    if (stats.isSymbolicLink()) continue; // directory symlinks are never followed
    if (!stats.isDirectory()) continue; // non-directory entries are preserved, not session dirs
    projectDirs.push(full);
  }
  return { projectDirs, issues };
}

/** Bounded-concurrency map that preserves input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function emptyCatalog(
  agentDir: string,
  sessionsRoot: string,
  revision: number,
  issues: SavedSessionIssue[] = [],
): SavedSessionCatalog {
  const catalog: SavedSessionCatalog = {
    agentDir,
    sessionsRoot,
    revision,
    rows: [],
    issues,
    issueCount: issues.length,
  };
  // Early-return catalogs are frozen exactly like normal results: the brand
  // must authenticate immutable minted data on every path, or a caller could
  // insert a stale row and rewrite root/revision into a current selection.
  for (const issue of issues) Object.freeze(issue);
  Object.freeze(issues);
  Object.freeze(catalog.rows);
  Object.freeze(catalog);
  catalogBrand.add(catalog);
  return catalog;
}

/**
 * List the normal shared native agent root's saved conversations read-only.
 *
 * - A missing sessions root yields an honest empty catalog (no error).
 * - A symlinked or non-directory sessions root yields an empty catalog with a
 *   bounded issue: it is never followed or invented around.
 * - Each approved project directory is listed with the public explicit
 *   flat-directory `listAll` overload under bounded concurrency; per-directory
 *   failures and malformed rows become bounded issues, never silent drops.
 * - No `HOME` or `process.env` mutation ever happens: the agent directory is
 *   always explicit, so the SDK's default-directory resolution is irrelevant.
 */
export async function listSavedSessions(options: ListSavedSessionsOptions): Promise<SavedSessionCatalog> {
  throwIfAborted(options.signal);

  const agentDirInput = options.agentDir;
  if (!isAbsolute(agentDirInput)) {
    throw new Error(`pi-review-gate: the saved-session catalog agent directory must be an absolute path: ${agentDirInput}`);
  }
  let agentStats;
  try {
    agentStats = lstatSync(agentDirInput);
  } catch {
    throw new Error(`pi-review-gate: the saved-session catalog agent directory does not exist: ${agentDirInput}`);
  }
  if (agentStats.isSymbolicLink() || !agentStats.isDirectory()) {
    throw new Error(`pi-review-gate: the saved-session catalog agent directory is not a real directory: ${agentDirInput}`);
  }
  const agentDir = realpathSync(agentDirInput);
  const sessionsRoot = join(agentDir, SAVED_SESSIONS_DIRNAME);
  const revision = nextCatalogRevision(agentDir);

  let rootStats;
  try {
    rootStats = lstatSync(sessionsRoot);
  } catch {
    return emptyCatalog(agentDir, sessionsRoot, revision); // missing sessions root: honest empty
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return emptyCatalog(agentDir, sessionsRoot, revision, [
      { projectDir: sessionsRoot, reason: "sessions root is not a real directory" },
    ]);
  }

  let listAll: NonNullable<ListSavedSessionsOptions["listAll"]>;
  if (options.listAll !== undefined) {
    if (typeof options.listAll !== "function") {
      throw new Error("pi-review-gate: the injected saved-session listAll must be a function");
    }
    listAll = options.listAll;
  } else {
    if (!options.piExecutable) {
      throw new Error(
        "pi-review-gate: the saved-session catalog needs the resolved native pi executable (or an injected listAll) to locate the public session SDK",
      );
    }
    const sdk = resolveNativeSessionSdk(options.piExecutable);
    listAll = sdk.SessionManager.listAll.bind(sdk.SessionManager);
  }

  const { projectDirs, issues: discoveryIssues } = discoverProjectSessionDirs(sessionsRoot);
  const issues: SavedSessionIssue[] = [...discoveryIssues];
  const rows: SavedSessionRow[] = [];

  const sessionsRootReal = realpathSync(sessionsRoot);
  const perDirResults = await mapWithConcurrency(projectDirs, MAX_PROJECT_LIST_CONCURRENCY, async (projectDir) => {
    throwIfAborted(options.signal);
    let infos: NativeSessionSdkInfo[];
    try {
      infos = await listAll(projectDir, undefined, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw error; // an aborted query rejects wholesale
      issues.push({ projectDir, reason: "session listing failed" });
      return [];
    }
    // A listing that resolves AFTER cancellation (instead of rejecting)
    // must not contribute rows to a published catalog.
    throwIfAborted(options.signal);
    if (!Array.isArray(infos)) {
      issues.push({ projectDir, reason: "session listing returned no rows" });
      return [];
    }
    const dirRows: SavedSessionRow[] = [];
    for (const info of infos) {
      if (info === null || typeof info !== "object") {
        issues.push({ projectDir, reason: "malformed session entry" });
        continue;
      }
      if (typeof info.path !== "string" || info.path.length === 0
        || typeof info.id !== "string" || info.id.length === 0
        || typeof info.cwd !== "string" || info.cwd.length === 0) {
        issues.push({ projectDir, reason: "malformed session entry" });
        continue;
      }
      const observed = isAbsolute(info.path) ? info.path : join(projectDir, info.path);
      let stats;
      try {
        stats = lstatSync(observed, { bigint: true });
      } catch {
        issues.push({ projectDir, reason: "session file missing" });
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        // Preserved untouched; a symlinked or special file is never admissible.
        issues.push({ projectDir, reason: "session file is not a regular file" });
        continue;
      }
      const canonicalFile = realpathSync(observed);
      if (!canonicalFile.startsWith(`${sessionsRootReal}${sep}`)) {
        issues.push({ projectDir, reason: "session file outside the sessions root" });
        continue;
      }
      const row: SavedSessionRow = {
        id: info.id,
        file: canonicalFile,
        cwd: info.cwd,
        caption: canonicalSavedSessionCaption(info.name, info.firstMessage),
        projectDir,
        ...(info.created instanceof Date ? { createdAt: info.created } : {}),
        ...(info.modified instanceof Date ? { modifiedAt: info.modified } : {}),
      };
      // Capture the observed identity privately BEFORE publishing the row so
      // admission can detect a file replaced after cataloging (identical
      // header bytes, new inode) instead of trusting the current inode.
      rowIdentity.set(row, { dev: stats.dev, ino: stats.ino });
      dirRows.push(row);
    }
    return dirRows;
  });

  // Never publish a catalog for a canceled query, even when every listing
  // resolved late with valid rows.
  throwIfAborted(options.signal);

  for (const dirRows of perDirResults) rows.push(...dirRows);

  // Deterministic presentation order: most recently modified first, then file.
  rows.sort((a, b) => {
    const am = a.modifiedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bm = b.modifiedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (am !== bm) return bm - am;
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });

  const catalogIssues = issues.slice(0, MAX_CATALOG_ISSUES);
  const catalog: SavedSessionCatalog = {
    agentDir,
    sessionsRoot,
    revision,
    rows,
    issues: catalogIssues,
    issueCount: issues.length,
  };
  // Deep-freeze every identity-bearing object so the brand authenticates
  // immutable minted data: a caller cannot push fabricated rows, rewrite the
  // revision/root fields, or retarget a row after the catalog is published.
  for (const issue of catalogIssues) Object.freeze(issue);
  Object.freeze(catalogIssues);
  for (const row of rows) Object.freeze(row);
  Object.freeze(rows);
  Object.freeze(catalog);
  catalogBrand.add(catalog);
  return catalog;
}

/**
 * Admit one exact catalog row as the deliberate per-child saved-session
 * selection. Fail-closed on every check; the result is an ephemeral branded
 * receipt (or a precise refusal reason), never a mutated user file:
 *
 * - The row must be a member of this exact catalog (no caller-fabricated
 *   rows), and the catalog must still hold the current query revision for its
 *   agent directory (a superseded or aborted completion cannot mint an
 *   admission).
 * - The file must still exist at the canonical path as a regular,
 *   non-symlink file inside `<agentDir>/sessions`, with a parseable
 *   first-line header whose id and cwd match the catalog row exactly
 *   (replacement or unknown content refuses; the bounded header read never
 *   copies the transcript).
 * - The recorded workspace must still be an existing directory; otherwise
 *   admission is disabled with a clear reason rather than inventing a cwd.
 * - Caller-supplied owned live sessions (ids/files) refuse known-owned
 *   duplicates; no external process discovery happens.
 */
/**
 * Shared structural validation for a saved-session path, used by BOTH
 * admission and launch revalidation: the sessions root and the project
 * directory must remain real (non-symlink) directories, and the file must sit
 * directly inside that project directory. A project directory moved outside
 * the sessions root and replaced with a symlink preserves the file's inode
 * and header identity but escapes the canonical root; this check catches it.
 */
export function validateSavedSessionLocation(
  agentDir: string,
  file: string,
): SavedSessionRefusalReason | undefined {
  const sessionsRoot = join(agentDir, SAVED_SESSIONS_DIRNAME);
  const relativeFile = relative(sessionsRoot, file);
  if (relativeFile.startsWith("..") || isAbsolute(relativeFile)) return "outside-sessions-root";
  const segments = relativeFile.split(sep).filter(Boolean);
  if (segments.length !== 2) return "outside-sessions-root";
  let rootStats;
  try {
    rootStats = lstatSync(sessionsRoot);
  } catch {
    return "missing-file";
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) return "outside-sessions-root";
  const projectDir = join(sessionsRoot, segments[0]);
  let projectStats;
  try {
    projectStats = lstatSync(projectDir);
  } catch {
    return "missing-file";
  }
  if (projectStats.isSymbolicLink() || !projectStats.isDirectory()) return "outside-sessions-root";
  return undefined;
}

export function admitSavedSession(
  catalog: SavedSessionCatalog,
  row: SavedSessionRow,
  options: AdmitSavedSessionOptions = {},
): SavedSessionAdmissionResult {
  if (!isSavedSessionCatalog(catalog)) {
    return { status: "refused", reason: "unknown-row" };
  }
  if (!catalog.rows.includes(row)) {
    return { status: "refused", reason: "unknown-row" };
  }
  const currentRevision = catalogRevisions.get(catalog.agentDir) ?? 0;
  if (currentRevision !== catalog.revision) {
    return { status: "refused", reason: "stale-catalog" };
  }

  // The sessions root and project directory must still be real directories
  // containing the file directly (shared with launch revalidation).
  const structureIssue = validateSavedSessionLocation(catalog.agentDir, row.file);
  if (structureIssue !== undefined) {
    return { status: "refused", reason: structureIssue };
  }

  let stats;
  try {
    stats = lstatSync(row.file, { bigint: true });
  } catch {
    return { status: "refused", reason: "missing-file" };
  }
  if (stats.isSymbolicLink()) return { status: "refused", reason: "symlink-file" };
  if (!stats.isFile()) return { status: "refused", reason: "not-a-regular-file" };

  // The live file must still be the exact file observed when the row was
  // minted: a replacement with identical header bytes gets a new inode and is
  // refused here, not admitted on header content alone.
  const observed = rowIdentity.get(row);
  if (observed === undefined) return { status: "refused", reason: "unknown-row" };
  if (stats.dev !== observed.dev || stats.ino !== observed.ino) {
    return { status: "refused", reason: "replaced-file" };
  }

  const header = readSavedSessionHeader(row.file);
  if (header === undefined) return { status: "refused", reason: "malformed-header" };
  if (header.id !== row.id || header.cwd !== row.cwd) {
    return { status: "refused", reason: "replaced-file" };
  }

  // The header cwd must be absolute and still an existing directory; its
  // canonical form is bound to the admission so launch can require the same
  // workspace rather than accepting a receipt for one workspace and launching
  // another.
  if (!isAbsolute(header.cwd)) {
    return { status: "refused", reason: "workspace-unavailable" };
  }
  let workspaceReal;
  try {
    if (!isExistingDirectory(header.cwd)) {
      return { status: "refused", reason: "workspace-unavailable" };
    }
    workspaceReal = realpathSync(header.cwd);
  } catch {
    return { status: "refused", reason: "workspace-unavailable" };
  }

  for (const owned of options.ownedLiveSessions ?? []) {
    if (typeof owned?.id === "string" && owned.id.length > 0 && owned.id === header.id) {
      return { status: "refused", reason: "known-owned-duplicate" };
    }
    if (typeof owned?.file === "string" && owned.file.length > 0
      && canonicalizePath(owned.file) === canonicalizePath(row.file)) {
      return { status: "refused", reason: "known-owned-duplicate" };
    }
  }

  const admission: SavedSessionAdmission = {
    agentDir: catalog.agentDir,
    file: row.file,
    sessionId: header.id,
    cwd: header.cwd,
    workspace: workspaceReal,
    dev: stats.dev,
    ino: stats.ino,
  };
  Object.freeze(admission);
  admissionBrand.add(admission);
  return { status: "admitted", admission };
}
