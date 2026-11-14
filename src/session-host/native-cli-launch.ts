import { realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { resolveApplicationCommand } from "../application-command";
import {
  externalAgentCatalog,
  type ExternalAgentAdapter,
  type ReviewGateConfig,
} from "../config";
import {
  rejectAndStripInheritedHostCapabilities,
  snapshotNativeEnvironment,
  type NativeLaunchDescriptor,
} from "./launch";
import { type NativeCliBackend } from "./session-backend";

/**
 * Native interactive CLI launch descriptors (issue #277, launch-adapter slice).
 *
 * This module prepares the exact `{file, args, env, cwd}` descriptor for one
 * real, full-screen interactive Claude Code or Codex PTY session. It prepares
 * only: it never spawns, never bootstraps the session-host protocol, never
 * installs provider configuration, hooks, or telemetry, and never reads live
 * provider credentials. The host manager that owns the PTY consumes the
 * descriptor.
 *
 * Contract:
 *
 * - **Bare native startup.** The child is the operator's own native CLI with
 *   its own configured permissions, model, sandbox, resume, and config
 *   discovery. No headless/SDK/app-server/print path, no added approval flags,
 *   no provider flag translation. The one deliberate added argument is Codex
 *   `--no-daemon`, which keeps this hosted TUI inside its own process instead
 *   of connecting to or starting the shared default server; nothing else is
 *   added (notably not `--no-alt-screen`). A Codex build old enough to lack
 *   `--no-daemon` fails at startup with its own argument error and is NOT
 *   retried without the flag: silently dropping it would attach this session
 *   to the shared daemon, which is exactly what the flag exists to prevent.
 * - **One discovery path.** The configured command is located with the shared
 *   `resolveApplicationCommand` resolver the settings availability probe uses —
 *   one filesystem/PATH/PATHEXT/case detector, not two — then canonicalized to
 *   one absolute file. That shared algorithm does not make this agree with the
 *   probe's answer: the probe resolves against its own process and the
 *   environment the settings layer assembles, while this resolves against the
 *   workspace below and the composed child environment. Relative command
 *   spellings (`./wrapper`) and relative PATH entries are anchored to the
 *   selected workspace, because that is the directory the host spawns the child
 *   in — never the host process cwd.
 *   Wrappers and explicit paths are honored faithfully; a command string
 *   (whitespace or shell metacharacters in a bare name) is refused — argv
 *   arrays only, no shell is ever involved.
 * - **Shared configuration only.** A configured target reuses the shared
 *   external-agent `command`, `args`, and `env`. Role overlays (reviewer or
 *   executor args/env/model/reasoning) are never consulted: a hosted
 *   interactive session is not a delegated role. Shared args that name a
 *   provider-native headless/service mode, an approval or sandbox bypass, a
 *   startup session/resume/worktree/remote switch, or a hook-trust bypass are
 *   refused rather than silently dropped or translated. Arguments that select
 *   the operator's own settings, MCP servers, plugins, agents, or appended
 *   prompt are configuration the operator explicitly chose for this target, so
 *   they are forwarded unchanged. Every option spelling is checked, including
 *   the compact attached forms (`-anever`, `-sdanger-full-access`,
 *   `-capproval_policy="never"`, `--flag=value`); a documented value-taking
 *   option's operand is data and is never read as a subcommand; and past a `--`
 *   terminator every remaining token is the provider's own prompt data,
 *   forwarded exactly and never read as an option or subcommand.
 * - **One Codex clipboard compatibility marker.** A Codex child environment —
 *   built-in or explicitly configured target — carries `HERDR_ENV=1` so the
 *   provider additionally emits a terminal OSC 52 copy request on its own row
 *   (see `applyCodexTerminalClipboardMode` for the exact upstream branch, its
 *   child-only scope, and what it never changes). Claude and native Pi get no
 *   marker, and no multiplexer or SSH marker is ever faked.
 * - **No inherited host capability.** The environment is a clone sanitized by
 *   the same provider-neutral sanitizer the native Pi launch uses: worker role
 *   authorization is rejected fail-closed, and stale session-host bootstrap,
 *   startup-request, title, NODE_OPTIONS-restore, and settlement/quiescence
 *   markers are stripped (including from a configured overlay). The user's
 *   original `NODE_OPTIONS` survives exactly as-is — no preload is staged —
 *   and native `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and provider
 *   authentication inheritance stay untouched. No Pi configuration is
 *   initialized.
 *
 * Validation coverage is source-level plus in-process fixtures. On Windows the
 * batch delivery above is what the real pinned ConPTY acceptance in the native
 * Windows CI jobs exercises with synthetic Node programs, and only that native
 * run can report what cmd.exe actually delivers; no real provider CLI is
 * launched by any of it.
 */

/**
 * The provider backends this host can launch as a real interactive TUI. The
 * closed set is owned by `session-backend.ts`; this module only re-exports that
 * identity type so its own import path keeps working. The re-export is
 * type-only: it adds no runtime dependency and no behavior here.
 */
export type { NativeCliBackend };

/** One selectable native interactive CLI launch target. */
export interface NativeCliTarget {
  /**
   * Stable host-side identity. The built-in defaults are `claude` and `codex`;
   * an explicit configured shared external-agent CLI entry is `external:<id>`,
   * so a configured id that happens to read `claude` can never collide with
   * the default target.
   */
  id: string;
  backend: NativeCliBackend;
  /** Operator-facing label: a target name only, never a path, command, or argument value. */
  label: string;
}

/** The reserved default target ids, one per backend. */
export const NATIVE_CLI_DEFAULT_TARGET_IDS: Readonly<Record<NativeCliBackend, string>> = {
  claude: "claude",
  codex: "codex",
};

/** Every selectable target: the two defaults plus configured shared Claude/Codex CLI entries. */
export function listNativeCliTargets(config: ReviewGateConfig): NativeCliTarget[] {
  return nativeCliTargetRecords(config).map((record) => record.target);
}

/** Request for one native interactive launch descriptor. */
export interface NativeCliLaunchRequest {
  /** Absolute existing workspace directory the native TUI runs in. */
  workspace: string;
  /** Environment to clone for the child; the caller's object is never mutated. */
  env: NodeJS.ProcessEnv;
  /** Exact target id; absence selects that backend's default target. */
  targetId?: string;
}

/** Prepared descriptor producer for one normalized configuration. */
export type NativeCliLauncher = (
  backend: NativeCliBackend,
  request: NativeCliLaunchRequest,
) => Promise<NativeLaunchDescriptor>;

export interface NativeCliLauncherOptions {
  /**
   * Platform injection keeps discovery, `PATHEXT`, and the `.cmd`/`.bat`
   * adaptation hermetic in tests; production callers pass nothing.
   */
  platform?: NodeJS.Platform;
  /**
   * The PARENT environment the trusted Windows `cmd.exe` is resolved from
   * (defaults to `process.env`), handed unchanged to the shipped launcher's one
   * trusted resolver. Only this parent environment's validated `SystemRoot` is
   * consulted — never the child environment, `ComSpec`, or PATH.
   */
  parentEnvironment?: NodeJS.ProcessEnv;
}

/** A target resolved to the exact shared configuration it launches from. */
interface NativeCliTargetRecord {
  target: NativeCliTarget;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
}

const BACKEND_LABEL: Readonly<Record<NativeCliBackend, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
};

/** Only the Claude and Codex CLI adapters describe a native interactive TUI. */
function nativeBackendForAdapter(adapter: ExternalAgentAdapter): NativeCliBackend | undefined {
  if (adapter === "claude-cli") return "claude";
  if (adapter === "codex-cli") return "codex";
  return undefined;
}

/**
 * Derive every selectable target from the already-normalized configuration
 * (no second loader or parser): the two defaults first, then the keyed
 * external-agent catalog in its derived alphabetical order.
 */
function nativeCliTargetRecords(config: ReviewGateConfig): NativeCliTargetRecord[] {
  const records: NativeCliTargetRecord[] = (["claude", "codex"] as const).map((backend) => ({
    target: {
      id: NATIVE_CLI_DEFAULT_TARGET_IDS[backend],
      backend,
      label: `${BACKEND_LABEL[backend]} (default)`,
    },
    command: backend,
    args: [],
    env: {},
  }));
  for (const agent of externalAgentCatalog(config)) {
    const backend = nativeBackendForAdapter(agent.adapter);
    if (!backend) continue;
    // Keys are data, never property names: the prefixed id is a lookup value
    // held in a list, and the default ids above stay reserved.
    const id = `external:${agent.id}`;
    if (records.some((record) => record.target.id === id)) continue;
    records.push({
      target: { id, backend, label: `${agent.id} (${BACKEND_LABEL[backend]})` },
      command: agent.command ?? backend,
      // Shared command/base args/base env only: `review`/`execution` overlays,
      // their models, and their reasoning settings are never consulted here.
      args: agent.args ?? [],
      env: agent.env ?? {},
    });
  }
  return records;
}

/** A refusal that never carries environment values, argument values, or searched paths. */
function refuse(reason: string): Error {
  return new Error(`pi-review-gate: refusing to prepare a native interactive CLI launch; ${reason}`);
}

/** A configured command is echo-able only when it is a bare filename, never a path. */
function safeCommandLabel(command: string): string {
  return /[/\\]/.test(command) ? "the configured command" : command;
}

/** Control characters can never cross argv or the environment safely. */
function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw refuse(`${BACKEND_LABEL.claude} and ${BACKEND_LABEL.codex} hosting supports macOS/Linux and Windows descriptors only; ${platform} is unsupported`);
  }
}

/**
 * The exact workspace a native session runs in: absolute, existing, and
 * canonical, so the descriptor is independent of the host process cwd.
 */
function canonicalNativeWorkspace(workspace: string): string {
  if (typeof workspace !== "string" || !isAbsolute(workspace)) {
    throw refuse("the native CLI workspace must be an absolute path");
  }
  let canonical: string;
  try {
    canonical = realpathSync(workspace);
  } catch {
    throw refuse("the native CLI workspace does not exist as a readable directory");
  }
  if (!statSync(canonical).isDirectory()) throw refuse("the native CLI workspace is not a directory");
  return canonical;
}

/**
 * Why one shared argument cannot appear in a native interactive launch. Each
 * entry is a documented native option (observed in the installed CLIs' help
 * output), never an invented wrapper policy: a shared argument exists to make
 * a bounded non-interactive reviewer/executor invocation work, and forwarding
 * it into a full-screen TUI would either launch something else entirely or
 * change the operator's own approval, session, or configuration posture.
 *
 * The categories are deliberately narrow. Choosing a settings file, an MCP
 * configuration, a plugin directory, or an agent definition is the operator
 * configuring the very target they selected, so those arguments are forwarded
 * untouched; only a documented headless/service path, an approval, sandbox, or
 * hook-trust bypass, an existing-session attach, or a workspace-scope switch is
 * refused.
 */
type RejectionCategory = "headless or service mode"
  | "approval or sandbox bypass"
  | "startup session/resume selection"
  | "workspace scope switch";

interface NativeArgumentPolicy {
  /** Documented option names refused in any `--flag` or `--flag=value` spelling. */
  options: Readonly<Record<RejectionCategory, readonly string[]>>;
  /**
   * Documented options that consume a following operand. Their operand is a
   * value, never a subcommand: `--profile review` stays a profile selection
   * while a bare `review` still replaces the TUI.
   */
  valueOptions: readonly string[];
  /** Documented subcommand words: each replaces the interactive TUI entirely. */
  subcommands: readonly string[];
  /**
   * Option names whose VALUE is a configuration assignment: refused only when
   * the assigned key itself names an approval or sandbox policy.
   */
  configOverrides?: readonly string[];
}

const CLAUDE_ARGUMENT_POLICY: NativeArgumentPolicy = {
  options: {
    // Print/stream-json/SDK plumbing and the background-session supervisor.
    "headless or service mode": [
      "-p", "--print", "--output-format", "--input-format", "--include-partial-messages",
      "--include-hook-events", "--replay-user-messages", "--json-schema",
      "--permission-prompt-tool", "--bg", "--background",
    ],
    // Every documented way to silence or override the native approval posture.
    "approval or sandbox bypass": [
      "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
      "--permission-mode", "--permission-prompts", "--allowedTools", "--disallowedTools", "--tools",
    ],
    // Parent startup must never attach a hosted session to another conversation.
    "startup session/resume selection": [
      "-c", "--continue", "-r", "--resume", "--session-id", "--fork-session",
      "--no-session-persistence",
    ],
    "workspace scope switch": ["-w", "--worktree", "--tmux", "--add-dir"],
  },
  // Observed Claude Code options that take a value (their operand is data).
  valueOptions: [
    "-m", "--model", "--fallback-model", "-n", "--name", "--effort",
    "--permission-mode", "--permission-prompts", "--permission-prompt-tool",
    "--session-id", "-r", "--resume", "--output-format", "--input-format",
    "--settings", "--setting-sources", "--mcp-config", "--plugin-dir",
    "--tools", "--allowedTools", "--disallowedTools", "--append-system-prompt",
    "--add-dir", "-w", "--worktree", "--agents",
  ],
  // Observed Claude Code subcommand surface; none of these is the interactive TUI.
  subcommands: ["agents", "plugin", "mcp", "doctor", "auth", "install", "gateway", "ultrareview"],
};

const CODEX_ARGUMENT_POLICY: NativeArgumentPolicy = {
  options: {
    // app-server / exec-server / daemon / proxy / remote-control transports,
    // the `exec` headless form's own options, and remote attachment.
    "headless or service mode": [
      "--listen", "--json", "--output-last-message", "--output-schema",
      "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules",
      "--remote", "--remote-auth-token-env",
    ],
    "approval or sandbox bypass": [
      "--yolo", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust",
      "-s", "--sandbox", "-a", "--ask-for-approval", "--approve-for-me", "--not-so-yolo",
    ],
    "startup session/resume selection": [],
    "workspace scope switch": ["-C", "--cd", "--worktree", "--add-dir"],
  },
  // Observed Codex options that take a value (their operand is data).
  valueOptions: [
    "-C", "--cd", "--add-dir", "-m", "--model", "-p", "--profile", "-c", "--config",
    "-s", "--sandbox", "-a", "--ask-for-approval", "-i", "--image",
    "--enable", "--disable", "--remote", "--remote-auth-token-env", "--listen",
    "--output-last-message", "--output-schema", "--worktree",
  ],
  // Observed Codex 0.167 subcommand surface; none of these is the interactive TUI.
  subcommands: [
    "agents", "exec", "review", "login", "logout", "mcp", "mcp-server", "plugin",
    "app-server", "app", "remote-control", "sandbox", "resume", "queue", "archive",
    "delete", "unarchive", "fork", "cloud", "exec-server", "features", "doctor",
    "debug", "apply", "completion", "update",
  ],
  // `-c key=value` is Codex's configuration channel; only a key that names
  // the operator's approval or sandbox policy is refused.
  configOverrides: ["-c", "--config"],
};

const CODEX_CONFIG_BYPASS_KEYS: readonly string[] = ["approval_policy", "sandbox_mode"];

/**
 * The one deliberate added argument: keep this TUI's backend in its own
 * process instead of attaching to (or starting) the shared default server. It
 * goes into a real option position — last, so a wrapper prefix
 * (`node wrapper.js`) stays exactly as configured, but before a `--`
 * terminator (past which the provider reads prompt text rather than an option)
 * and before a value-taking option that is still missing its operand, which
 * would otherwise read the flag as its value. Only an option in real option
 * position counts as an already-configured `--no-daemon`, so it is honored once
 * and never duplicated or mistaken for a positional. There is deliberately no
 * fallback if an older Codex build rejects it.
 */
const CODEX_NO_DAEMON_ARG = "--no-daemon";

/**
 * The option a shared argument spells, plus the value spelled inside the same
 * token. Both CLIs' option parsers accept the compact forms, so `-anever`,
 * `-sdanger-full-access`, `-capproval_policy="never"`, `-c=approval_policy="never"`, and
 * `--ask-for-approval=never` all name the same option as their split spellings;
 * only the option NAME is ever reported in a refusal.
 */
interface ParsedOption {
  name: string;
  attached?: string;
}

function parseOption(arg: string): ParsedOption | undefined {
  if (!arg.startsWith("-") || arg === "-" || arg === "--") return undefined;
  if (!arg.startsWith("--")) {
    // Single dash: both `-xVALUE` and `-x=VALUE` attach a value. The optional
    // separator is removed for the check only; the forwarded argv token stays
    // exactly as configured.
    return arg.length === 2
      ? { name: arg }
      : { name: arg.slice(0, 2), attached: arg.slice(2).replace(/^=/, "") };
  }
  const equals = arg.indexOf("=");
  return equals === -1 ? { name: arg } : { name: arg.slice(0, equals), attached: arg.slice(equals + 1) };
}

/** Validate the shared args, then compose the exact interactive argv. */
function composeNativeArgs(
  backend: NativeCliBackend,
  args: readonly string[],
  targetId: string,
): string[] {
  const policy = backend === "claude" ? CLAUDE_ARGUMENT_POLICY : CODEX_ARGUMENT_POLICY;
  const rejected = (category: RejectionCategory, option: string): never => {
    throw refuse(`target "${targetId}" cannot start a native interactive session because its shared args include the ${category} option ${option}`);
  };
  const argv: string[] = [];
  // The provider's own option boundary. Everything after a `--` is prompt data
  // for the provider, so it is forwarded exactly and never read as an option,
  // a subcommand, or a reason to refuse; our own option has to precede it.
  let terminatorIndex = -1;
  // True while the next token is the operand of a documented value-taking option.
  let pendingOperand = false;
  // The index of that pending option, or -1. The isolation flag must never land
  // where the provider would read it as another option's operand.
  let pendingOperandIndex = -1;
  // Set once the insertion point is known: the terminator position, or the
  // pending option a bare `--` would have served as the operand of.
  let insertionIndex: number | undefined;
  // Only an option spelled in real option position isolates the daemon.
  let daemonIsolationActive = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== "string" || containsControlCharacter(arg)) {
      throw refuse(`target "${targetId}" has a shared argument that is not a printable string`);
    }
    // An empty token is data exactly where the provider reads data: as the
    // operand of a documented value-taking option (`--setting-sources ""`
    // selects no settings layer, just like the attached `--setting-sources=`)
    // or past the `--` terminator. Anywhere else it names neither an option nor
    // a prompt, so it stays refused. Control characters stay refused anywhere.
    if (arg.length === 0 && terminatorIndex === -1 && !pendingOperand) {
      throw refuse(`target "${targetId}" has a shared argument that is not a printable non-empty string`);
    }
    argv.push(arg);
    // Past the terminator the provider never parses options, so a token that
    // merely spells an option or a subcommand is literal prompt text: refusing
    // it would drop the operator's own prompt, and re-reading it as an option
    // would be a second, invented parser. Only the first `--` is the boundary.
    if (terminatorIndex !== -1) continue;
    if (arg === "--") {
      terminatorIndex = index;
      // A `--` that is still expected as an option's operand is data, so the
      // flag goes before the option that would otherwise swallow it.
      insertionIndex = pendingOperandIndex >= 0 ? pendingOperandIndex : index;
      pendingOperand = false;
      continue;
    }
    if (pendingOperand) {
      // A documented option's operand is data: never a subcommand.
      pendingOperand = false;
      pendingOperandIndex = -1;
      continue;
    }
    const option = parseOption(arg);
    if (option === undefined) {
      // A bare positional that exactly spells a documented subcommand replaces
      // the interactive TUI with that subcommand's own behavior.
      if (policy.subcommands.includes(arg)) rejected("headless or service mode", arg);
      continue;
    }
    for (const [category, names] of Object.entries(policy.options) as [RejectionCategory, readonly string[]][]) {
      if (names.includes(option.name)) rejected(category, option.name);
    }
    if (policy.configOverrides?.includes(option.name)) {
      const assignment = option.attached ?? args[index + 1];
      const key = typeof assignment === "string" ? assignment.split("=")[0].trim() : undefined;
      if (key !== undefined && CODEX_CONFIG_BYPASS_KEYS.includes(key)) {
        rejected("approval or sandbox bypass", option.name);
      }
    }
    if (option.attached === undefined && option.name === CODEX_NO_DAEMON_ARG) daemonIsolationActive = true;
    if (option.attached === undefined && policy.valueOptions.includes(option.name)) {
      pendingOperand = true;
      pendingOperandIndex = index;
    }
  }
  if (backend === "codex" && !daemonIsolationActive) {
    // Real option position: before the terminator, before a pending option that
    // would otherwise take the flag as its value, otherwise last.
    const insertion = insertionIndex ?? (pendingOperandIndex >= 0 ? pendingOperandIndex : argv.length);
    argv.splice(insertion, 0, CODEX_NO_DAEMON_ARG);
  }
  return argv;
}

/**
 * The one environment variable a hosted Codex child is given for terminal text
 * copy: `HERDR_ENV` with the exact value `1`.
 *
 * Upstream Codex (`codex-rs/tui/src/clipboard_copy.rs`, inspected at the pinned
 * `rust-v0.167.2` tag) always attempts its native OS clipboard write, and when
 * this variable is exactly `1` it ADDITIONALLY writes one terminal OSC 52 copy
 * request (`\x1b]52;c;<base64>`, direct — not tmux/screen-wrapped unless the
 * child really is inside an inherited multiplexer) to its own controlling
 * terminal, which under this host is the row's PTY. That emitted request is
 * what lets text be copied OUT of a hosted Codex row, including into a network
 * viewer; the provider's own native write keeps happening exactly as it does
 * for a locally-run Codex. Nothing else in the inspected source reads this
 * variable.
 *
 * This is a narrow compatibility use of an existing upstream branch, not an
 * integration: `HERDR_ENV` is undocumented in Codex, its semantics belong to
 * upstream and can widen in a future release, and no HERDR repository, code,
 * dependency, or attribution is involved here. No provider version probe, no
 * added CLI argument, and no other environment marker: `SSH_TTY`,
 * `SSH_CONNECTION`, `TMUX`, `TMUX_PANE`, and `STY` stay exactly as inherited,
 * In particular, pretending to be an SSH session would switch off Codex's own
 * clipboard-text read, its right-click paste, and its local image links — behavior
 * the operator keeps. Multiplexer markers have their own unrelated effects.
 */
const CODEX_TERMINAL_CLIPBOARD_ENV = "HERDR_ENV";

/** The only value the upstream branch recognizes. */
const CODEX_TERMINAL_CLIPBOARD_VALUE = "1";

/**
 * Set the Codex clipboard compatibility marker on one composed CHILD
 * environment, in place, after every environment source has merged.
 *
 * Scope is exactly this one variable on this one child:
 *
 * - It is called for a Codex target only, and only on the descriptor's own
 *   cloned environment, so the caller's request object, the launcher options,
 *   and the host process environment are never mutated.
 * - Because it runs after the configured shared overlay merged, the host-owned
 *   mode intentionally wins for this single key: a preexisting `HERDR_ENV` of
 *   any value — inherited or configured — is replaced. Every other composed
 *   entry (inheritance, the configured overlay, `PWD`, and the Windows batch
 *   percent carrier) keeps the value the ordinary composition gave it.
 * - Windows environment names are case-insensitive, so the child must resolve
 *   one spelling. The shared snapshot already uppercases every name it
 *   composes; dropping any other spelling of this key first keeps that
 *   invariant, so the assignment replaces the single canonical entry instead of
 *   adding an alias the child could pick either way. POSIX names stay
 *   case-sensitive, so an unrelated differently-cased variable is the
 *   operator's own and is never touched.
 */
function applyCodexTerminalClipboardMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    for (const name of Object.keys(env)) {
      if (name !== CODEX_TERMINAL_CLIPBOARD_ENV && name.toUpperCase() === CODEX_TERMINAL_CLIPBOARD_ENV) {
        delete env[name];
      }
    }
  }
  env[CODEX_TERMINAL_CLIPBOARD_ENV] = CODEX_TERMINAL_CLIPBOARD_VALUE;
}

/**
 * Compose the child environment: a clone of the caller's environment through
 * the shared provider-neutral sanitizer, then the selected target's SHARED
 * env overlay (the caller adds the canonical `PWD` once the workspace is
 * resolved). Native provider configuration and
 * authentication variables are inherited untouched; nothing Pi-specific is
 * initialized, and no capability the child did not already own survives —
 * including through the overlay, which is sanitized a second time so a
 * configured value can never reintroduce one.
 */
function composeNativeEnvironment(
  requestEnv: NodeJS.ProcessEnv | undefined,
  sharedEnv: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env = snapshotNativeEnvironment(requestEnv ?? process.env, platform);
  rejectAndStripInheritedHostCapabilities(env);
  // The overlay is a second environment source, so it gets the same
  // case-normalizing snapshot and the same fail-closed role rejection BEFORE it
  // merges. Without that, a Windows pair such as
  // `{ PI_REVIEW_GATE_RUNTIME_ROLE: "executor", pi_review_gate_runtime_role: "" }`
  // would uppercase sequentially and overwrite the nonempty authorization
  // marker with the empty alias before any check could see it.
  const overlay = snapshotNativeEnvironment(sharedEnv, platform);
  rejectAndStripInheritedHostCapabilities(overlay);
  for (const [name, value] of Object.entries(overlay)) {
    if (typeof value !== "string" || containsControlCharacter(name) || containsControlCharacter(value)) {
      throw refuse("a configured shared environment entry is not a printable string");
    }
    // The snapshot already carries exactly one canonical spelling per name, so
    // the overlay targets the entry the child resolves instead of adding a
    // second variant it could pick either way.
    env[name] = value;
  }
  // Belt and braces: no capability survives the merge in any spelling.
  rejectAndStripInheritedHostCapabilities(env);
  return env;
}

function isUsableRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

interface LauncherHelpers {
  cmdQuote: (arg: string) => string;
  /** Resolves the parent's trusted `SystemRoot\\System32\\cmd.exe`, or null. */
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
}

let cachedLauncherHelperPath: string | undefined;

/**
 * Locate the shipped launcher helper module. Both shipped layouts keep scripts/
 * beside the compiled extension, so scripts/ is found by walking upward to the
 * enclosing package root.
 */
function launcherHelperPath(): string {
  if (cachedLauncherHelperPath !== undefined) return cachedLauncherHelperPath;
  for (let dir = __dirname; ; dir = join(dir, "..")) {
    const candidate = join(dir, "scripts", "pi-review-gate-launcher.cjs");
    if (isUsableRegularFile(candidate)) {
      cachedLauncherHelperPath = candidate;
      return candidate;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
  }
  throw refuse("the shipped launcher helper scripts/pi-review-gate-launcher.cjs was not found beside the compiled extension");
}

/**
 * The shipped launcher's own cmd quoting and trusted `cmd.exe` resolution.
 * This adapter deliberately keeps no second copy of either rule: the launcher
 * is the single authority for both, and requiring the helper per call (Node
 * caches the module) runs exactly what the shipped launcher exports.
 */
function loadLauncherHelpers(): LauncherHelpers {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const helper = require(launcherHelperPath()) as Partial<LauncherHelpers>;
  if (typeof helper.cmdQuote !== "function") {
    throw refuse("the shipped launcher helper is missing its cmd quoting helper");
  }
  if (typeof helper.resolveTrustedWindowsCmd !== "function") {
    throw refuse("the shipped launcher helper is missing its trusted Windows cmd resolver");
  }
  return helper as LauncherHelpers;
}

/**
 * The internal Windows batch percent carrier's canonical name prefix. It is
 * product-internal transport metadata, never operator-facing, and the numeric
 * suffix keeps the chosen slot clear of any variable the child already owns.
 */
const WINDOWS_PERCENT_CARRIER_PREFIX = "PRG_NATIVE_BATCH_PCT_";

/** The carrier's whole value: the single percent sign it exists to deliver. */
const WINDOWS_PERCENT_CARRIER_VALUE = "%";

/**
 * The first unused canonical carrier name in the environment the batch child
 * starts with. Windows names arrive in one canonical spelling from the shared
 * snapshot, so this one check covers every case spelling, and an existing
 * operator variable is never overwritten or cleared. A finite environment holds
 * finitely many names, so one probe past its size always finds a free slot:
 * preserving the literal argument never costs a valid launch a refusal.
 */
function windowsPercentCarrierName(environment: Readonly<NodeJS.ProcessEnv>): string {
  const slots = Object.keys(environment).length + 1;
  for (let probe = 0; probe < slots; probe += 1) {
    const name = `${WINDOWS_PERCENT_CARRIER_PREFIX}${probe}`;
    if (!Object.hasOwn(environment, name)) return name;
  }
  // Unreachable: at most `slots - 1` of these `slots` names can already exist.
  throw refuse("no internal Windows batch percent carrier name is free in the configured child environment");
}

/**
 * A `.cmd`/`.bat` shim runs as a batch command through the trusted cmd.exe.
 *
 * The command text is composed with the launcher's single `cmdQuote` authority,
 * so the shared argument rules apply unchanged and no layer invents its own
 * quoting. cmd.exe performs percent expansion while it READS the `/c` command
 * line — before quoting and tokenization — and offers no escape from it: `%%`
 * is a batch-source escape only (on a `/c` line `%%NAME%%` yields `%value%` for
 * a defined `NAME`, and cmd performs no `%%` to `%` reduction there), and a
 * caret is consumed later than the expansion. So a percent cannot be TYPED
 * faithfully into a batch command line.
 *
 * It can be DELIVERED faithfully. Expansion is a single left-to-right pass, so
 * a `%NAME%` reference whose value is one `%` leaves a literal percent that cmd
 * never reads again. Every percent in the batch text is therefore replaced with
 * a reference to one internal carrier variable that carries exactly `%`, and the
 * carrier is cleared by a leading `set "NAME=" &` in the same line: the whole
 * line expands from the environment cmd.exe starts with, then the reference is
 * gone before the shim — and so before the CLI process that inherits it — runs.
 * What cmd.exe tokenizes afterwards is exactly the text this quoting produces
 * for an argument whose percent cmd left alone, so every other character keeps
 * the delivery the Windows acceptance suite already proves, and no argument is
 * refused, expanded, or reclassified.
 *
 * The batch invocation also carries `/v:off`. Delayed expansion is off by
 * default, but a machine can turn it on for every `cmd.exe` through its Command
 * Processor settings, and then a `!NAME!` in the operator's own argument would
 * expand while the shim forwards `%*` — printable-argv fidelity that depends on
 * whose machine this is. Naming the switch makes literal bangs literal here
 * instead. This is the native interactive CLI batch launch only: the shipped
 * launcher's Pi batch path keeps its own `/d /s /c` invocation unchanged.
 */
function adaptWindowsBatchShim(
  shim: string,
  args: readonly string[],
  parentEnvironment: NodeJS.ProcessEnv,
  childEnvironment: NodeJS.ProcessEnv,
): { file: string; args: string[]; commandLine: string; env: NodeJS.ProcessEnv } {
  const helpers = loadLauncherHelpers();
  // The parent environment only: the child environment, ComSpec, and PATH stay
  // irrelevant, so a `.cmd`/`.bat` CLI shim never selects its own interpreter.
  const cmdExe = helpers.resolveTrustedWindowsCmd(parentEnvironment);
  if (!cmdExe) {
    throw refuse("a valid regular cmd.exe was not found under the parent process's absolute Windows SystemRoot\\System32, so the configured .cmd/.bat CLI shim cannot be launched");
  }
  // Percent-free batch text stays byte-identical to the delivery before it: no
  // carrier, no clearing, no change to a single quoted token.
  const percentCarrier = [shim, ...args].some((token) => token.includes("%"))
    ? windowsPercentCarrierName(childEnvironment)
    : undefined;
  const quoteToken = (token: string): string => helpers.cmdQuote(percentCarrier === undefined
    ? token
    : token.replace(/%/gu, `%${percentCarrier}%`));
  const env = percentCarrier === undefined
    ? childEnvironment
    : { ...childEnvironment, [percentCarrier]: WINDOWS_PERCENT_CARRIER_VALUE };
  // cmd.exe expands the whole command line from the environment it starts with,
  // so this clearance runs after every carrier above has expanded and before the
  // shim — and therefore before the CLI process that inherits the environment.
  const carrierClearance = percentCarrier === undefined ? "" : `set "${percentCarrier}=" & `;
  const commandText = [shim, ...args].map(quoteToken).join(" ");
  // The pinned PTY's public Windows spawn takes either an argv array — which it
  // escapes itself per the MSDN command-line rules — or one pre-escaped
  // command-line string appended verbatim after the program path. cmd.exe needs
  // this whole `/d /s /v:off /c "…"` remainder verbatim, exactly as Node's
  // `windowsVerbatimArguments` spawn hands it to the shell, because cmd.exe does
  // not treat a backslash as an escape. Passed as argv, the outer quotes would
  // reach cmd.exe as `\"` and the batch command line would be re-tokenized
  // against the operator's own arguments, so the batch invocation is delivered
  // only in the string form and its argv stays empty.
  return {
    file: cmdExe,
    args: [],
    commandLine: `/d /s /v:off /c "${carrierClearance}${commandText}"`,
    env,
  };
}

/**
 * Create the native interactive CLI launcher for one already-normalized
 * configuration (no live config, auth, or provider reads happen here).
 *
 * - With no `targetId`, the backend's default target is selected. An explicit
 *   `targetId` must match a current target whose backend is the requested
 *   backend, or the launch is refused: identity and backend never fall back to
 *   a first match or a substitution.
 * - The selected command is located by the shared application-command resolver
 *   against the child's effective environment, then canonicalized.
 * - The result is the ordinary `NativeLaunchDescriptor` the session host
 *   already consumes: canonical file, exact interactive argv, cloned sanitized
 *   environment, canonical workspace.
 */
export function createNativeCliLauncher(
  config: ReviewGateConfig,
  options: NativeCliLauncherOptions = {},
): NativeCliLauncher {
  return async (backend, request) => {
    const platform = options.platform ?? process.platform;
    assertSupportedPlatform(platform);
    if (backend !== "claude" && backend !== "codex") {
      throw refuse(`"${String(backend)}" is not a native interactive CLI backend`);
    }
    if (request === null || typeof request !== "object") {
      throw refuse("a native CLI launch request with a workspace and environment is required");
    }
    const records = nativeCliTargetRecords(config);
    const targetId = request.targetId;
    const record = targetId === undefined
      ? records.find((candidate) => candidate.target.backend === backend
        && candidate.target.id === NATIVE_CLI_DEFAULT_TARGET_IDS[backend])
      : records.find((candidate) => candidate.target.id === targetId);
    if (!record) {
      throw refuse(`target ${JSON.stringify(targetId ?? NATIVE_CLI_DEFAULT_TARGET_IDS[backend])} is not a configured native interactive CLI target`);
    }
    if (record.target.backend !== backend) {
      throw refuse(`target "${record.target.id}" is a ${BACKEND_LABEL[record.target.backend]} target and cannot launch a ${BACKEND_LABEL[backend]} session`);
    }
    const { target, command, args, env: sharedEnv } = record;

    // A bare name must be one exact filename: a whitespace- or
    // metacharacter-bearing "name" is a shell command line, and no shell is
    // ever involved in a native launch. An explicit path is a whole filename
    // and may legitimately contain spaces or quotes.
    const bareName = !command.includes("/") && !(platform === "win32" && command.includes("\\"));
    if (bareName && (/\s/.test(command) || /[|&;$<>()`\\'"]/.test(command))) {
      throw refuse(`target "${target.id}" names a shell command string rather than a single executable filename`);
    }

    // The child environment first, so a configured PATH override is the PATH
    // discovery actually searches (same rule the settings availability probe
    // applies) and the located file is the file the child would execute.
    const env = composeNativeEnvironment(request.env, sharedEnv, platform);
    // The Codex clipboard compatibility marker is applied to the composed child
    // environment only, once normal target and environment resolution is done,
    // so it wins for this one variable over any configured or inherited value
    // while leaving the rest of the composition untouched (Claude and Pi
    // descriptors receive nothing).
    if (backend === "codex") applyCodexTerminalClipboardMode(env, platform);
    const cwd = canonicalNativeWorkspace(request.workspace);
    env.PWD = cwd;
    // Discovery anchors to the workspace the child is actually spawned in, so a
    // relative command or a relative PATH entry resolves exactly as the spawn
    // would resolve it — never against the host process cwd.
    const located = await resolveApplicationCommand(command, env, platform, cwd);
    if (located === undefined) {
      throw refuse(`the ${safeCommandLabel(command)} executable for target "${target.id}" was not found; install the native CLI or configure an explicit command`);
    }
    let file: string;
    try {
      // The async canonicalization is deliberate: Node's synchronous realpath
      // collapses a `..` lexically, so a located path such as
      // `<workspace>/./link/../wrapper` (where `link` is a symlinked directory)
      // would be reported missing even though the spawn in that workspace runs
      // the file the resolver selected. This still refuses anything that cannot
      // be canonicalized at all.
      file = await realpath(located);
    } catch {
      throw refuse(`the located executable for target "${target.id}" could not be canonicalized`);
    }

    const argv = composeNativeArgs(backend, args, target.id);
    if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      const batch = adaptWindowsBatchShim(file, argv, options.parentEnvironment ?? process.env, env);
      return { file: batch.file, args: batch.args, commandLine: batch.commandLine, env: batch.env, cwd };
    }
    return { file, args: argv, env, cwd };
  };
}
