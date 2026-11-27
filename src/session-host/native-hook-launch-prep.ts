/**
 * Per-launch native status hook preparation (issue #277, launch-preparation slice).
 *
 * One hosted native CLI row is observed by the existing local status broker
 * through the one-shot relay in ./native-hook-relay. For that relay to run at
 * all, the provider must be told — at startup, in its own documented
 * configuration channel — to invoke it. This module prepares exactly that
 * instruction for one launch: the provider flags to add, the one child
 * environment marker that carries the fresh per-launch bootstrap, and the
 * private artifacts those flags point at. It never spawns anything, never
 * registers a broker source, never touches provider configuration, trust,
 * permissions, or global state, and never claims that a hook actually fired.
 *
 * Acquisition is OPTIONAL and owner-supplied. With no hook option the launcher
 * composes exactly the descriptor it composed before this module existed.
 *
 * Provider channels (source-verified, no invented switches):
 *
 * - **Claude Code** merges hook layers additively, but a second `--settings`
 *   REPLACES the operator's flag-settings layer, so at most ONE `--settings`
 *   may ever be added, and only when the configured argv carries none in real
 *   option position. That file carries ONLY a `hooks` key. When the operator
 *   already supplies `--settings`, the approved session-only fallback is one
 *   additional `--plugin-dir` holding a hooks-only plugin (a minimal manifest
 *   plus its `hooks/hooks.json`, no JavaScript, no MCP server, no commands,
 *   no skills). `--plugin-dir` is documented as repeatable and session-scoped,
 *   and existing entries stay exactly as configured. Either route is still
 *   subject to the operator's own native policy — `disableSideloadFlags`,
 *   marketplace policy, and workspace trust can withhold hooks entirely. This
 *   module honors that: it bypasses nothing, and an armed observer whose hooks
 *   the provider declines to run simply stays unknown.
 * - **Codex** has no per-launch settings file; `-c key=value` (SessionFlags)
 *   is the only per-launch layer, same-layer paths are last-wins with arrays
 *   replaced, and file-based hooks from other layers stay additive. So the
 *   injection is exactly one `-c hooks.SessionStart=[…]` — enough to acquire
 *   the current owned transcript binding — and it is skipped entirely when the
 *   operator already writes `hooks` or `hooks.SessionStart` in real option
 *   position, because then adding ours would replace theirs. `hooks.state`
 *   (the trust record) is never written, and no trust-bypass flag is ever
 *   emitted: a new or changed hook command still needs the operator's own
 *   native `/hooks` approval.
 *
 * Command stability is deliberate. The provider's hook-trust record is keyed by
 * command content, so the generated command carries the Node executable and
 * the compiled relay entry only — never a token, instance id, socket path, or
 * generation. Those live in the child-environment marker
 * (`NATIVE_HOOK_BOOTSTRAP_ENV`), which the relay authenticates from. That is
 * what lets every row of one host share one stable, trustable command while
 * still authenticating per launch.
 *
 * Artifacts are freshly owned and private: a new `mkdtemp` root under the
 * system temporary directory (never inside a workspace), `0700` directories,
 * `0600` files, exclusive creation, and a cleanup that removes only the exact
 * inodes this call created. An entry it cannot identify as its own is
 * preserved, and the root is removed only when it is still empty — never a
 * recursive delete, never a sweep of anything else.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createSessionHostStateDirectory } from "./roster-store";
import {
  rejectAndStripInheritedHostCapabilities,
  snapshotNativeEnvironment,
} from "./launch";
import {
  NATIVE_HOOK_BOOTSTRAP_ENV,
  encodeNativeHookBootstrapEnv,
  parseNativeHookBootstrap,
  type NativeHookBootstrap,
  type NativeHookEventName,
} from "./native-hook-protocol";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";
// Type-only: the launch adapter owns the one argv scanner, and this module only
// reads the facts it already computed. There is no runtime import back.
import type { NativeArgPositionScan } from "./native-cli-launch";

/**
 * How long the provider may wait for one relay attempt. The relay bounds its
 * own stdin read, connect, and acknowledgement separately, so this is only a
 * provider-side ceiling that keeps an unreachable broker from stalling a turn.
 */
export const NATIVE_HOOK_TIMEOUT_SECONDS = 5;

/**
 * The Claude events this host observes: exactly the events the closed relay
 * protocol admits, all of which are real Claude Code hook events. Tool
 * payloads are never relayed; the events carry status edges and the validated
 * Stop-family background snapshot only.
 */
export const CLAUDE_NATIVE_HOOK_EVENTS: readonly NativeHookEventName[] = Object.freeze([
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
]);

/**
 * The Codex events this host observes: `SessionStart` only. It is the one event
 * that yields the current owned transcript binding, and Codex lacks two of the
 * admitted names (`PostToolUseFailure`, `StopFailure`), so a wider set would
 * either be rejected or would mean guessing at a provider surface this slice
 * did not establish.
 */
export const CODEX_NATIVE_HOOK_EVENTS: readonly NativeHookEventName[] = Object.freeze([
  "SessionStart",
]);

/** Which provider channel armed the observer for this launch. */
export type NativeHookAcquisitionRoute =
  | "claude-settings-file"
  | "claude-plugin-dir"
  | "codex-session-start";

/**
 * Closed reasons why observation was NOT armed. Every one of them means the
 * caller keeps reporting that row's native status as unknown; none of them is a
 * launch failure, and none of them changed the operator's launch.
 */
export type NativeHookAcquisitionUnavailableReason =
  /** The operator already writes the same-layer hook configuration we would need. */
  | "operator-hook-override"
  /** The generated command cannot be delivered faithfully by this provider on this platform. */
  | "unsafe-command-quoting"
  /** The Node host or the compiled relay entry this launch would invoke is not usable. */
  | "hook-entry-unavailable"
  /** The private artifact could not be staged (or was staged and then rolled back). */
  | "artifact-staging-failed"
  /** The bootstrap cannot be carried in the bounded child-environment marker. */
  | "bootstrap-unusable";

/** Exact kernel identity of one owned artifact entry, observed at creation. */
interface OwnedIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OwnedEntry extends OwnedIdentity {
  readonly path: string;
  readonly kind: "file" | "directory";
}

/** What one lease cleanup actually did. Paths are this module's own artifacts. */
export interface NativeHookArtifactCleanup {
  readonly removed: readonly string[];
  /** Owned paths left in place because their identity or contents changed. */
  readonly preserved: readonly string[];
}

/**
 * The caller's handle on the artifacts this preparation staged. The manager
 * releases it only AFTER the provider source and its PTY have settled; nothing
 * here observes a process or guesses when settlement happened. Cleanup is
 * idempotent and reports exactly what it removed and what it refused to touch.
 */
export interface NativeHookArtifactLease {
  /** Canonical root of the freshly owned artifact directory, or null when this route stages no files. */
  readonly root: string | null;
  cleanup(): Promise<NativeHookArtifactCleanup>;
}

/**
 * Observation armed for this launch. `prepared` is a statement about THIS
 * launch's configuration only: the provider was given its own documented
 * instruction to invoke the relay. It is never a claim that the hook will run —
 * the operator's native policy (Claude workspace trust, `disableSideloadFlags`,
 * marketplace policy, `disableAllHooks`; Codex `/hooks` trust approval) can
 * still withhold it, and this module neither bypasses those gates nor inspects
 * them. Events simply never arrive, and the row stays unknown.
 */
export interface NativeHookLaunchPrepared {
  readonly observation: "prepared";
  readonly backend: NativeCliBackend;
  readonly route: NativeHookAcquisitionRoute;
  /**
   * The generated provider flags, in the order they were composed. They carry
   * no secret: the token travels only in `environment`.
   */
  readonly args: readonly string[];
  /** The single fresh child-environment entry, keyed by the canonical marker name. */
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: NativeHookArtifactLease;
}

/** Observation deliberately not armed; the launch proceeds unchanged. */
export interface NativeHookLaunchUnavailable {
  readonly observation: "unavailable";
  readonly backend: NativeCliBackend;
  readonly reason: NativeHookAcquisitionUnavailableReason;
}

export type NativeHookLaunchOutcome = NativeHookLaunchPrepared | NativeHookLaunchUnavailable;

/** Absolute existing files the generated hook command invokes. */
export interface NativeHookEntrypoints {
  readonly nodeExecutable: string;
  readonly relayEntry: string;
}

/** Input for one preparation. The caller owns every field; none is mutated. */
export interface NativeHookLaunchPreparationInput {
  readonly backend: NativeCliBackend;
  /** Fresh bootstrap issued by the broker's native-only registration for this launch. */
  readonly bootstrap: NativeHookBootstrap;
  readonly platform: NodeJS.Platform;
  /** The configured argv tokens the launch composes from. */
  readonly args: readonly string[];
  /**
   * Real-option-position facts from the launch adapter's ONE argv scanner.
   * Detection and insertion share that scan rather than re-reading argv here.
   */
  readonly scan: NativeArgPositionScan;
  /**
   * The environment this launch will hand the child. Only read, never mutated:
   * a genuine worker-role authorization in it is rejected before any artifact
   * exists.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Windows only: the shipped launcher's single `cmdQuote` authority. Codex
   * runs a hook command through the platform shell, so a Windows command
   * string is built with the same quoting the product already trusts; without
   * it a Windows Codex observer is declined rather than quoted by a second rule.
   */
  readonly windowsCommandQuoter?: (token: string) => string;
  /**
   * Test seam for literal-path coverage only: production passes nothing and the
   * launch adapter never sets it. Both values still have to be absolute
   * regular files.
   */
  readonly entrypoints?: NativeHookEntrypoints;
}

/** A refusal for a request that violates this module's contract. */
function refuse(reason: string): Error {
  return new Error(`pi-review-gate: refusing to prepare native status hooks; ${reason}`);
}

/** The same printable-text rule the launch adapter applies to argv and env. */
function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function unavailable(
  backend: NativeCliBackend,
  reason: NativeHookAcquisitionUnavailableReason,
): NativeHookLaunchUnavailable {
  return { observation: "unavailable", backend, reason };
}

/**
 * The compiled relay entry sits beside this module in every shipped and test
 * layout, so its own directory is the only place it is looked for.
 */
function defaultRelayEntry(): string {
  return join(__dirname, "native-hook-relay.js");
}

function isUsableRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The two absolute files the generated hook command names. A missing entry is a
 * broken installation, not an operator error: the operator's launch stays
 * exactly as configured and this row simply stays unknown.
 */
function resolveHookEntrypoints(
  entrypoints: NativeHookEntrypoints | undefined,
): NativeHookEntrypoints | null {
  const nodeExecutable = entrypoints?.nodeExecutable ?? process.execPath;
  const relayEntry = entrypoints?.relayEntry ?? defaultRelayEntry();
  for (const candidate of [nodeExecutable, relayEntry]) {
    if (typeof candidate !== "string" || candidate.length === 0
      || !isAbsolute(candidate) || containsControlCharacter(candidate)) return null;
    if (!isUsableRegularFile(candidate)) return null;
  }
  return { nodeExecutable, relayEntry };
}

/**
 * POSIX shell quoting for one token. Codex hands its hook command to
 * `$SHELL -lc`, so single quotes with the `'\''` idiom are the only form that
 * survives every printable character literally — including spaces, quotes,
 * percent signs, and cmd metacharacters, which are ordinary bytes here.
 */
export function posixQuotedToken(token: string): string {
  return `'${token.replace(/'/gu, `'\\''`)}'`;
}

/** One TOML basic string, exactly as Codex's `-c` value parser expects it. */
export function tomlBasicString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") out += "\\\\";
    else if (character === '"') out += '\\"';
    else if (character === "\b") out += "\\b";
    else if (character === "\t") out += "\\t";
    else if (character === "\f") out += "\\f";
    else if (character === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}

/**
 * The Codex hook command strings. Only Codex needs them: its handler schema has
 * no exec form, so the provider hands this one string to the platform shell,
 * while Claude's exec form carries the same paths as data with no shell at all.
 * POSIX is always faithful. On Windows the provider invokes the command through
 * `cmd.exe /C`, where percent expansion happens while the line is READ and
 * cannot be escaped, and a machine-wide delayed-expansion setting makes `!`
 * expand too — and unlike our own batch launch there is no `/v:off` we control.
 * A path carrying either character is therefore declined, never approximated.
 */
function buildHookCommands(
  entrypoints: NativeHookEntrypoints,
  platform: NodeJS.Platform,
  windowsCommandQuoter: ((token: string) => string) | undefined,
): { readonly posix: string; readonly windows?: string } | null {
  const posix = `${posixQuotedToken(entrypoints.nodeExecutable)} ${posixQuotedToken(entrypoints.relayEntry)}`;
  if (platform !== "win32") return { posix };
  const tokens = [entrypoints.nodeExecutable, entrypoints.relayEntry];
  if (tokens.some((token) => /[%!]/u.test(token))) return null;
  if (typeof windowsCommandQuoter !== "function") return null;
  const windows = tokens.map((token) => windowsCommandQuoter(token)).join(" ");
  if (containsControlCharacter(windows)) return null;
  return { posix, windows };
}

/** The closed hook-entry shape one provider accepts, in its own schema. */
function claudeHookEventMap(
  entrypoints: NativeHookEntrypoints,
): Record<string, readonly unknown[]> {
  const entry = {
    type: "command",
    command: entrypoints.nodeExecutable,
    args: [entrypoints.relayEntry],
    timeout: NATIVE_HOOK_TIMEOUT_SECONDS,
    onFailure: "continue",
  };
  const map: Record<string, readonly unknown[]> = {};
  // No `matcher` and no `if`: the observer watches every event of these kinds,
  // and `if` is only evaluated on tool events, so filtering here would silently
  // withhold the status edges this host depends on.
  for (const event of CLAUDE_NATIVE_HOOK_EVENTS) map[event] = [{ hooks: [entry] }];
  return map;
}

/**
 * Codex's inline TOML value for one event path. The path's value is an array
 * of MATCHER GROUPS, and each group's `hooks` array holds the handlers
 * (`[[SessionStart]] matcher = … / [[SessionStart.hooks]] type = "command" …`);
 * a handler spelled directly in the outer array would deserialize as a group
 * with no handlers, so the observer would load as a silent no-op.
 */
function codexSessionStartValue(commands: { readonly posix: string; readonly windows?: string }): string {
  const handler = [
    "type=\"command\"",
    `command=${tomlBasicString(commands.posix)}`,
    ...(commands.windows === undefined ? [] : [`commandWindows=${tomlBasicString(commands.windows)}`]),
    `timeout=${NATIVE_HOOK_TIMEOUT_SECONDS}`,
  ].join(",");
  return `hooks.${CODEX_NATIVE_HOOK_EVENTS[0]}=[{hooks=[{${handler}}]}]`;
}

/** True when the operator already writes the Codex hook configuration we would add. */
function codexHookOverrideConflict(scan: NativeArgPositionScan): boolean {
  return scan.options.some((option) => {
    if (option.name !== "-c" && option.name !== "--config") return false;
    const assignment = option.attached ?? option.operand;
    if (typeof assignment !== "string") return false;
    // Codex splits the override at the first `=`, trims both halves, and then
    // walks the key on `.`. The same reading decides what would collide.
    const segments = assignment.split("=")[0].split(".").map((segment) => segment.trim());
    if (segments[0] !== "hooks") return false;
    // `hooks = {…}` replaces the whole table, and `hooks.SessionStart…` is the
    // exact last-wins path — including the Rust field spelling, which a
    // differently-written override could still mean. Anything under
    // `hooks.<other event>` is a different path and stays untouched.
    if (segments.length === 1) return true;
    return segments[1] === "SessionStart" || segments[1] === "session_start";
  });
}

/** True when the operator already supplies Claude's `--settings` in real option position. */
function claudeSettingsAlreadyConfigured(scan: NativeArgPositionScan): boolean {
  return scan.options.some((option) => option.name === "--settings");
}

/**
 * A freshly owned artifact namespace. Every entry is recorded with the kernel
 * identity it was created with, and removal is only ever attempted for that
 * identity AND for every ancestor directory that is still the one this call
 * recorded — so a replaced file, an unexpected extra entry, a replaced
 * intermediate directory, or a root that is no longer the directory this call
 * made (including a symlink standing in for it) is preserved rather than
 * deleted. Nothing is ever reached through a path whose ownership changed.
 *
 * Exported for the sibling native review lane (./native-review-hook-launch-prep),
 * which stages its own review-only plugin directory with the same ownership,
 * identity, and cleanup discipline — and with its own root prefix, so a review
 * artifact is always distinguishable from an observer artifact.
 */
export class OwnedArtifactNamespace {
  readonly root: string;
  readonly #entries: OwnedEntry[] = [];
  #result: NativeHookArtifactCleanup | undefined;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * `prefix` is this feature's own artifact-root prefix; the default is the
   * observer lane's. Every root is created fresh under the system temporary
   * directory, never inside a workspace.
   *
   * `preferPrivate` is the review lane's opt-in, and it changes nothing
   * anywhere else. It asks for a private root on a best-effort basis only, the
   * way Pi creates its own `auth.json`: on Windows, where `chmod` does not make
   * a directory private, the root is first attempted through the host's
   * protected-directory creator (a DACL for this account, LocalSystem, and
   * built-in Administrators set at creation), and when that creator is
   * unavailable or cannot verify its result the root is still created as an
   * ordinary directory. Whatever the temp directory or its ancestors grant to
   * other principals (a Codex sandbox users group on `%LOCALAPPDATA%\Temp`, for
   * example) is never a reason to refuse: this is an advisory review's hook
   * configuration, and the same principals can already edit Pi's own settings.
   * Only a real creation failure throws, which is the caller's existing
   * `unavailable` answer, reached before any plugin file is written.
   */
  static create(prefix = "prg-native-hook-", preferPrivate = false): OwnedArtifactNamespace {
    if (preferPrivate && process.platform === "win32") {
      const root = join(tmpdir(), `${prefix}${randomUUID()}`);
      const { outcome } = createSessionHostStateDirectory(root);
      if (outcome === "existing") throw new Error("native hook artifact root already exists");
      // `failed` means the protected creator made nothing; an ordinary directory
      // stands in, created exclusively so nothing pre-existing is ever adopted.
      if (outcome === "failed") mkdirSync(root);
      const namespace = new OwnedArtifactNamespace(root);
      namespace.#record(root, "directory");
      return namespace;
    }
    const created = mkdtempSync(join(tmpdir(), prefix));
    // The mode is set explicitly, not left to the process umask.
    chmodSync(created, 0o700);
    // Canonicalize once so the paths handed to the provider are the paths the
    // provider reads (macOS `/var` is itself a symlinked directory).
    const root = realpathSync(created);
    const namespace = new OwnedArtifactNamespace(root);
    namespace.#record(root, "directory");
    return namespace;
  }

  #record(path: string, kind: "file" | "directory"): void {
    if (this.#entries.some((entry) => entry.path === path)) return;
    const stats = lstatSync(path, { bigint: true });
    this.#entries.push({ path, kind, dev: stats.dev, ino: stats.ino });
  }

  /**
   * Creates one directory level at a time and records every directory this
   * call actually created — the leaf included, because a leaf that is not
   * recorded can never be removed and its whole subtree leaks. A level that
   * already exists is not ours to record or delete, so creation fails into the
   * caller's rollback path instead of silently adopting a foreign entry.
   */
  makeDirectory(relativePath: string): string {
    let path = this.root;
    for (const component of relativePath.split("/")) {
      if (component.length === 0) continue;
      path = join(path, component);
      if (this.#entries.some((entry) => entry.path === path)) continue;
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
      this.#record(path, "directory");
    }
    return path;
  }

  writeFile(relativePath: string, contents: string): string {
    const path = join(this.root, relativePath);
    // Exclusive creation: an entry that already exists is never overwritten.
    writeFileSync(path, contents, { mode: 0o600, flag: "wx" });
    chmodSync(path, 0o600);
    this.#record(path, "file");
    return path;
  }

  /**
   * Removes only what this namespace created, deepest first. A directory is
   * removed with a plain rmdir, so a root that now holds anything else survives
   * with its foreign entries intact. An entry whose ancestry changed is left
   * alone even when its own inode still matches: the path it is reached through
   * is no longer provably ours.
   */
  cleanup(): NativeHookArtifactCleanup {
    if (this.#result !== undefined) return this.#result;
    const removed: string[] = [];
    const preserved: string[] = [];
    for (const entry of [...this.#entries].reverse()) {
      if (!this.#stillOwns(entry) || !this.#ancestryIntact(entry)) {
        preserved.push(entry.path);
        continue;
      }
      try {
        // `rmdirSync` is already non-recursive: it refuses a directory that now
        // holds an entry this namespace never created, which is exactly the
        // conservative outcome — the foreign entry survives.
        if (entry.kind === "file") unlinkSync(entry.path);
        else rmdirSync(entry.path);
      } catch {
        preserved.push(entry.path);
        continue;
      }
      removed.push(entry.path);
    }
    this.#result = { removed, preserved };
    return this.#result;
  }

  /**
   * The entry itself, checked without following any link: still the same kernel
   * object of the expected kind, or nothing this call made. `lstat` is what
   * makes a symlink at a recorded path a different object rather than a route
   * to the old one.
   */
  #stillOwns(entry: OwnedEntry): boolean {
    let stats;
    try {
      stats = lstatSync(entry.path, { bigint: true });
    } catch {
      // Already gone counts as nothing to preserve and nothing to remove.
      return false;
    }
    if (stats.dev !== entry.dev || stats.ino !== entry.ino) return false;
    return entry.kind === "file" ? stats.isFile() : stats.isDirectory();
  }

  /**
   * True while the recorded root and every recorded directory between it and
   * this entry still carry the identities they were created with. An unrecorded
   * ancestor is never assumed: it cannot be proved, so it fails closed.
   */
  #ancestryIntact(entry: OwnedEntry): boolean {
    const root = this.#entries[0];
    // The root is the only entry with no ancestor above it, and it is always
    // recorded first.
    if (root === undefined || !this.#directoryMatches(root)) return false;
    if (entry.path === root.path) return true;
    const below = relative(this.root, entry.path).split(sep).slice(0, -1);
    let path = this.root;
    for (const component of below) {
      path = join(path, component);
      const recorded = this.#entries.find((candidate) => candidate.kind === "directory" && candidate.path === path);
      if (recorded === undefined || !this.#directoryMatches(recorded)) return false;
    }
    return true;
  }

  /** True only when the path is still a real directory with the recorded identity. */
  #directoryMatches(entry: OwnedEntry): boolean {
    let stats;
    try {
      stats = lstatSync(entry.path, { bigint: true });
    } catch {
      return false;
    }
    // A symlink standing where a recorded directory used to be is a different
    // object, however it resolves: nothing below it is removed through it.
    return stats.isDirectory() && !stats.isSymbolicLink()
      && stats.dev === entry.dev && stats.ino === entry.ino;
  }
}

/** Stage the Claude artifacts for one route, and report the flags that point at them. */
function stageClaudeArtifacts(
  namespace: OwnedArtifactNamespace,
  route: "claude-settings-file" | "claude-plugin-dir",
  entrypoints: NativeHookEntrypoints,
): string[] {
  const hooks = claudeHookEventMap(entrypoints);
  if (route === "claude-settings-file") {
    // A flag-settings file with a single top-level key: every other settings
    // layer and key the operator owns keeps its own value untouched.
    const settingsPath = namespace.writeFile(
      "claude-hook-settings.json",
      `${JSON.stringify({ hooks })}\n`,
    );
    return ["--settings", settingsPath];
  }
  // The approved session-only fallback: a hooks-only plugin. The manifest is
  // optional for the provider but keeps the plugin name stable and the
  // validator quiet; every other component directory stays absent, so nothing
  // but these hooks is loaded.
  const pluginRoot = namespace.makeDirectory("claude-observer-plugin");
  namespace.makeDirectory("claude-observer-plugin/.claude-plugin");
  namespace.makeDirectory("claude-observer-plugin/hooks");
  namespace.writeFile(
    "claude-observer-plugin/.claude-plugin/plugin.json",
    `${JSON.stringify({
      name: "pi-review-gate-native-observer",
      version: "1.0.0",
      description: "pi-review-gate read-only native session status hooks (no commands, agents, skills, or MCP servers)",
    })}\n`,
  );
  // A plugin hooks file carries the event map inside a top-level `hooks` key;
  // the bare event map would fail to load.
  namespace.writeFile(
    "claude-observer-plugin/hooks/hooks.json",
    `${JSON.stringify({ hooks })}\n`,
  );
  return ["--plugin-dir", pluginRoot];
}

/**
 * Prepare one launch's native status hooks.
 *
 * Contract, in order:
 *
 * 1. The bootstrap is re-validated strictly and its backend must be the
 *    requested backend; a foreign, half-built, or cross-backend bootstrap is a
 *    refusal, never a partial arming.
 * 2. A genuine worker-role authorization in the launch environment is rejected
 *    BEFORE any filesystem effect. The caller's environment object is never
 *    mutated, and no other value is read out of it.
 * 3. Conflicts are decided from the launch adapter's scan facts, so an
 *    option-like operand and everything past a `--` terminator are data, never
 *    a conflict, and never moved.
 * 4. Artifacts are staged last, in a freshly owned private root, and a failure
 *    partway through rolls back exactly what this call created.
 */
export async function prepareNativeHookLaunch(
  input: NativeHookLaunchPreparationInput,
): Promise<NativeHookLaunchOutcome> {
  const { backend, platform } = input;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw refuse(`native status hooks are prepared for macOS/Linux and Windows descriptors only; ${platform} is unsupported`);
  }
  if (!isNativeCliBackend(backend)) {
    throw refuse(`"${String(backend)}" is not a native interactive CLI backend`);
  }
  const bootstrap = parseNativeHookBootstrap(input.bootstrap);
  if (bootstrap === undefined) throw refuse("the native hook bootstrap is missing, malformed, or carries an unexpected field");
  if (bootstrap.backend !== backend) {
    throw refuse(`the native hook bootstrap is registered for ${bootstrap.backend} and cannot arm a ${backend} launch`);
  }

  // Fail closed on worker authorization before any artifact exists. This is a
  // second reading of the same provider-neutral rule the launch adapter
  // applies, so a direct caller of this module cannot stage files either.
  const roleProbe = snapshotNativeEnvironment(input.env ?? {}, platform);
  rejectAndStripInheritedHostCapabilities(roleProbe);

  let encodedBootstrap: string;
  try {
    encodedBootstrap = encodeNativeHookBootstrapEnv(bootstrap);
  } catch {
    return unavailable(backend, "bootstrap-unusable");
  }

  const entrypoints = resolveHookEntrypoints(input.entrypoints);
  if (entrypoints === null) return unavailable(backend, "hook-entry-unavailable");

  // The fresh marker is the same single entry for both backends and both
  // Claude routes; the secret never enters provider command text or an artifact.
  const environment: Readonly<Record<string, string>> = { [NATIVE_HOOK_BOOTSTRAP_ENV]: encodedBootstrap };

  if (backend === "codex") {
    if (codexHookOverrideConflict(input.scan)) {
      // Injecting here would replace the operator's own same-layer hooks. The
      // launch stays exactly as configured and this row is reported unknown.
      return unavailable(backend, "operator-hook-override");
    }
    // Only Codex needs a shell-delivered command, and only Codex can therefore
    // be declined for a path the platform shell could not deliver literally.
    const commands = buildHookCommands(entrypoints, platform, input.windowsCommandQuoter);
    if (commands === null) return unavailable(backend, "unsafe-command-quoting");
    // This route stages no file at all, so there is nothing to own or clean.
    return {
      observation: "prepared",
      backend,
      route: "codex-session-start",
      args: ["-c", codexSessionStartValue(commands)],
      environment,
      lease: { root: null, cleanup: async () => ({ removed: [], preserved: [] }) },
    };
  }

  // Claude's exec form (`command` plus `args`) is spawned directly by the
  // provider with no shell involved, so the two paths travel as data and no
  // platform quoting rule can distort them.
  const route: "claude-settings-file" | "claude-plugin-dir" = claudeSettingsAlreadyConfigured(input.scan)
    ? "claude-plugin-dir"
    : "claude-settings-file";
  let namespace: OwnedArtifactNamespace | undefined;
  try {
    namespace = OwnedArtifactNamespace.create();
    const args = stageClaudeArtifacts(namespace, route, entrypoints);
    const staged = namespace;
    return {
      observation: "prepared",
      backend,
      route,
      args,
      environment,
      lease: {
        root: staged.root,
        cleanup: async () => staged.cleanup(),
      },
    };
  } catch {
    namespace?.cleanup();
    return unavailable(backend, "artifact-staging-failed");
  }
}
