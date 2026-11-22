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
import { isNativeConversationId } from "./native-conversation";
import { type NativeHookBootstrap } from "./native-hook-protocol";
import {
  prepareNativeHookLaunch,
  type NativeHookLaunchOutcome,
} from "./native-hook-launch-prep";
import { parseNativeMcpBootstrap, type NativeMcpBootstrap } from "./native-mcp-protocol";
import {
  NATIVE_MCP_SERVER_NAME_PREFIX,
  NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH,
  isValidNativeMcpServerName,
  prepareNativeMcpLaunch,
  type NativeMcpLaunchOutcome,
} from "./native-mcp-launch-prep";
import {
  NATIVE_CLI_DEFAULT_TARGET_IDS,
  NATIVE_CLI_EXTERNAL_TARGET_PREFIX,
  projectNativeCliNewSessionTargets,
  type NativeCliBackend,
} from "./session-backend";

/**
 * Native interactive CLI launch descriptors (issue #277, launch-adapter slice).
 *
 * This module prepares the exact `{file, args, env, cwd}` descriptor for one
 * real, full-screen interactive Claude Code or Codex PTY session. It prepares
 * only: it never spawns, never bootstraps the session-host protocol, never
 * installs provider configuration or telemetry, and never reads live provider
 * credentials. The host manager that owns the PTY consumes the descriptor.
 *
 * The one opt-in exception is a status-hook preparation the OWNER explicitly
 * arms for a single launch (`NativeCliLaunchRequest.nativeHook`): the adapter
 * then adds that provider's own documented per-launch hook flags and one fresh
 * child-environment marker, and nothing else. With no such option — every
 * existing call site — the descriptor is exactly what this module composed
 * before hook support existed. See ./native-hook-launch-prep for what arming
 * does, what it refuses, and what it can never guarantee.
 *
 * The second opt-in exception is the native MCP relay instruction an owner may
 * arm for a single launch (`NativeCliLaunchRequest.nativeMcp`, #682): a Claude
 * launch gains one `--mcp-config=<private file>` defining only the relay server
 * under the owner-supplied stable host name, and an OWNED Codex launch gains
 * one `-c mcp_servers.<host name>=…`
 * on its app-server backend render only — never on the TUI and never on a
 * non-owned Codex launch. Only a private bootstrap file path reaches the
 * provider; no token enters argv or the environment. With no such option the
 * descriptor and every owned render are exactly what they were. Nothing in
 * production arms it yet. See ./native-mcp-launch-prep.
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
 * - **Preparation only in owned Codex backend mode.** A launcher constructed
 *   with `NativeCliLauncherOptions.ownedCodexBackend` attaches one extra
 *   read-only plan to a Codex descriptor so the future owning host can start
 *   one private app-server child and its TUI client from the same resolved
 *   target. This module still spawns nothing, selects no endpoint, generates no
 *   token, and owns no lease: the plan re-renders complete literal argv from the
 *   facts of this one launch through the same trusted Windows authority, and
 *   stages no new artifact on any render. With the option absent or false —
 *   every existing call site, production included — no descriptor carries a
 *   plan and nothing about a launch changes.
 * - **Owned Codex launches carry no owner-supplied status hook of ours.** The same
 *   construction-time mode is also the only launch for which this module declines its
 *   OWN hook preparation, even when the request armed it: the owning host already holds
 *   a private backend whose approved relay and read-only RPC supply this row's session
 *   metadata, so a hook instruction this host injected into the interactive child would
 *   be a second, competing channel whose only effect is to change the real argv and
 *   environment. Such a launch therefore stages no artifact, keeps `nativeHook` absent,
 *   and gains no generated flag or marker anywhere. Every operator-configured hook,
 *   configuration override, and CLI flag — including the operator's own
 *   `hooks.SessionStart` spelling — is still composed verbatim by the one scanner: what
 *   is declined is only this host's own instruction, never the operator's.
 * - **Exact restoration only by private owner intent.** A request's
 *   `resumeConversationId` (one exact UUID, explicit target) is the only resume
 *   authority: Claude gains `--resume <uuid>` in real option position, an owned
 *   Codex TUI renders `resume --remote … --remote-auth-token-env … <uuid>`, and
 *   a non-owned Codex restore is refused. Configured args that would replay
 *   startup input are refused for a restore, never stripped; a fresh launch is
 *   composed exactly as before.
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

/**
 * The reserved default target ids, one per backend. Owned by
 * `session-backend.ts`; re-exported so this module's import path keeps working.
 */
export { NATIVE_CLI_DEFAULT_TARGET_IDS };

/**
 * Every configured target identity this launcher can resolve: the two defaults
 * plus configured shared Claude/Codex CLI entries (`external:<id>`).
 *
 * This is NOT the app's native session choice list (#493): NEW sessions offer,
 * and remembered rows restore with, only the backend defaults —
 * {@linkcode listNativeCliNewSessionTargets} and `nativeCliRestoreTargetId`.
 */
export function listNativeCliTargets(config: ReviewGateConfig): NativeCliTarget[] {
  return nativeCliTargetRecords(config).map((record) => record.target);
}

/**
 * The native session choices among {@linkcode listNativeCliTargets}: exactly
 * the Claude and Codex default targets, never a named external worker profile
 * (#493). This is what a host offers for NEW sessions and the only targets its
 * restoration launches. Derived from the same canonical records through
 * `projectNativeCliNewSessionTargets`; no second registry.
 */
export function listNativeCliNewSessionTargets(config: ReviewGateConfig): readonly NativeCliTarget[] {
  return projectNativeCliNewSessionTargets(listNativeCliTargets(config));
}

/** Request for one native interactive launch descriptor. */
export interface NativeCliLaunchRequest {
  /** Absolute existing workspace directory the native TUI runs in. */
  workspace: string;
  /** Environment to clone for the child; the caller's object is never mutated. */
  env: NodeJS.ProcessEnv;
  /** Exact target id; absence selects that backend's default target. */
  targetId?: string;
  /**
   * OPTIONAL owner-supplied native status hook arming for this one launch.
   * Absence — the existing behavior — composes exactly the descriptor this
   * adapter composed before hook support existed: no added argument, no added
   * environment entry, no artifact. Presence carries only the fresh bootstrap
   * the broker's native-only registration issued for this row; the adapter
   * derives everything else and never mutates the caller's option object.
   */
  nativeHook?: NativeCliNativeHookOption;
  /**
   * OPTIONAL owner-supplied native MCP relay arming for this one launch (#682).
   * Absence — every existing call site — composes exactly the descriptor and
   * owned renders this adapter composed before: no argument, no environment
   * entry, no artifact. Presence carries only the fresh bootstrap the broker's
   * `registerNativeMcpSource` issued for this row; its backend must be the
   * requested backend. It is independent of `nativeHook` and never shares its
   * credentials.
   */
  nativeMcp?: NativeCliNativeMcpOption;
  /**
   * OPTIONAL owner-private restart restoration intent: one exact admitted
   * provider conversation UUID. This is the ONLY resume authority a native
   * launch has; configured resume/continue/fork spellings stay refused exactly
   * as before, with or without it.
   *
   * Absence composes exactly the fresh descriptor. Presence requires an exact
   * UUID and an explicit `targetId` (a restore never falls back to a default
   * target), and refuses any configured argument list that would replay startup
   * input — a positional prompt, prompt data after `--`, or an input-bearing
   * option such as an initial image or file — rather than stripping it. Claude
   * resumes with its documented `--resume <uuid>` in real option position; Codex
   * resumes only through the owned backend plan's `renderTui`, whose argv
   * becomes `… resume --remote <relay> --remote-auth-token-env <ENV> <uuid>`.
   * A non-owned Codex restore is refused, never started fresh. The value is
   * never logged, echoed in a refusal, or exposed on the descriptor.
   */
  resumeConversationId?: string;
  /**
   * OPTIONAL fresh SessionSpawn startup request (issue #493): the owner's short
   * generated instruction pointing at its own staged prompt file, never the
   * prompt itself, plus the exact title for Claude, whose native `--name=<title>`
   * option names the session. Codex has no native title option, so a Codex
   * request carrying a title is refused (the owner honors that title as the
   * row's caption instead). The instruction is appended as the single prompt
   * operand after a `--` terminator — after every operator and generated option —
   * so it can never be parsed as an option or subcommand.
   *
   * Only the backend's default target accepts it (the one native kind a
   * SessionSpawn selects), never a configured external worker profile, and it is
   * never combined with a restoration. Absence composes exactly the descriptor
   * this module composed before.
   */
  initialPrompt?: NativeCliInitialPromptOption;
}

/** The provider-facing half of one SessionSpawn startup request; never the prompt text. */
export interface NativeCliInitialPromptOption {
  /** One printable plain-word line generated by the owner's prompt staging. */
  instruction: string;
  /** Exact requested title; accepted for Claude only. */
  title?: string;
}

/** Claude's documented native session-name option, always attached so a title is never read as an option. */
const CLAUDE_NAME_OPTION = "--name";

/**
 * Validate one startup request and return its generated option tokens (in real
 * option position) and trailing prompt-operand tokens. Refusals never echo the
 * instruction or the title.
 */
function nativeInitialPromptArgs(
  backend: NativeCliBackend,
  option: unknown,
  targetId: string,
  defaultTarget: boolean,
): { readonly optionArgs: readonly string[]; readonly operandArgs: readonly string[] } {
  if (option === null || typeof option !== "object" || Array.isArray(option)) {
    throw refuse("a native startup request must carry its generated instruction");
  }
  const { instruction, title } = option as { instruction?: unknown; title?: unknown };
  if (typeof instruction !== "string" || instruction.length === 0 || containsControlCharacter(instruction)
    || /[\u0080-\u009f\u2028\u2029]/u.test(instruction) || !/^[A-Za-z]/u.test(instruction)) {
    throw refuse("a native startup instruction must be one printable line that starts with a plain word");
  }
  if (!defaultTarget) {
    throw refuse(`target "${targetId}" is not its backend's default target, so it cannot take a SessionSpawn startup request`);
  }
  const optionArgs: string[] = [];
  if (title !== undefined) {
    if (backend !== "claude") {
      throw refuse("this native CLI has no native title option; its startup title is not a launch argument");
    }
    if (typeof title !== "string" || title.trim().length === 0 || containsControlCharacter(title)
      || /[\u0080-\u009f\u2028\u2029]/u.test(title)) {
      throw refuse("a native startup title must be one printable nonblank line");
    }
    optionArgs.push(`${CLAUDE_NAME_OPTION}=${title}`);
  }
  return { optionArgs, operandArgs: ["--", instruction] };
}

/** The whole owner-supplied hook option: the registration bootstrap, nothing else. */
export interface NativeCliNativeHookOption {
  /**
   * `createStatusBroker().registerNativeHookSource(instanceId, backend, …)`
   * bootstrap for THIS launch, registered before the provider child exists.
   * Its backend must be the requested backend, and the marker name it is
   * carried in is stripped from every inherited environment, so only this
   * launch's child can ever authenticate a relay.
   */
  bootstrap: NativeHookBootstrap;
}

/** The whole owner-supplied MCP option: the registration bootstrap and the stable host server name. */
export interface NativeCliNativeMcpOption {
  /**
   * `createStatusBroker().registerNativeMcpSource(instanceId, backend, endpoint)`
   * bootstrap for THIS launch, registered before the provider child exists. It
   * is written once to a private file the relay consumes; it never enters the
   * child environment or any argv.
   */
  bootstrap: NativeMcpBootstrap;
  /**
   * The trusted owning host's stable, host-wide MCP server name: the fixed
   * `pi_review_gate_` prefix plus 32 lowercase hex digits generated randomly
   * ONCE per host and persisted by the host. Never a model name and never
   * generated per launch; this adapter only validates it. Absent or invalid is
   * a refusal before any environment, discovery, hook, or artifact work. Both
   * providers' instructions use exactly this name; an operator argv entry that
   * already names it (or any operator Claude `--mcp-config`, or a whole Codex
   * `mcp_servers` table) declines preparation. No provider-wide inventory is
   * required or read: a same-name server configured only in another provider
   * layer is accepted residual risk (see ./native-mcp-launch-prep).
   */
  serverName: string;
}

/**
 * The descriptor this adapter returns: the ordinary launch descriptor the
 * session host already consumes, plus the outcome of an explicitly armed hook
 * preparation. The extra field never changes the shape of `file`, `args`,
 * `commandLine`, `env`, or `cwd`, and it is absent whenever no hook option was
 * supplied.
 */
export interface NativeCliLaunchDescriptor extends NativeLaunchDescriptor {
  /**
   * Present only when the request armed native status hooks. `prepared` means
   * the flags and the fresh marker are in this descriptor and the caller now
   * owns `lease` (release it only after the provider source and its PTY have
   * settled); `unavailable` means nothing was added and the row stays reported
   * unknown.
	 *
	 * An owned Codex launch (the field below present) never carries this outcome:
	 * this module prepares no status hook of its own for a launch whose owning
	 * host already owns the backend beside it.
   */
  readonly nativeHook?: NativeHookLaunchOutcome;
  /**
   * Present only when the request armed the native MCP relay. `prepared` means
   * the caller now owns `lease` (release it only after the provider child and
   * its broker registration have settled) and the generated flags are placed
   * per `placement`: in this descriptor's argv for Claude, or ONLY in
   * `ownedCodex.renderBackend` for an owned Codex launch (this descriptor's own
   * argv and env, and `renderTui`, stay unarmed). `unavailable` means nothing
   * was added anywhere.
   */
  readonly nativeMcp?: NativeMcpLaunchOutcome;
  /**
   * Present only for a Codex launch prepared by a launcher constructed with
   * `NativeCliLauncherOptions.ownedCodexBackend`. It is a rendering plan, not a
   * second child and not an ownership claim: the ordinary `file`, `args`,
	 * `commandLine`, `env`, and `cwd` fields above stay exactly what an unarmed
	 * launch composes. `nativeHook` is absent here by design: an owned launch
	 * stages no hook artifact of ours, so there is nothing for a caller to own,
	 * and neither rendered child receives a generated flag or marker.
   */
  readonly ownedCodex?: NativeCodexOwnedLaunchPlan;
}

/** Prepared descriptor producer for one normalized configuration. */
export type NativeCliLauncher = (
  backend: NativeCliBackend,
  request: NativeCliLaunchRequest,
) => Promise<NativeCliLaunchDescriptor>;

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
  /**
   * Attach the optional owned Codex backend plan to Codex launches (default
   * false). This is a construction-time property of one launcher instance, set
   * by the future owning host for itself: it is never a user setting, never a
   * per-request field, and never something a peer, wire message, or provider
   * can claim. Absent or false — every existing call site — no launch carries a
   * plan and every descriptor is byte-identical to the one this module composed
   * before the mode existed.
   *
   * True also means this launcher prepares no owner-supplied status hook of ours
   * for the Codex launches it plans, whether or not the request armed one: the
   * approved relay and its read-only RPC are the metadata channel of an owned
   * row, so the interactive child's real argv and environment gain no hook
   * instruction, no marker, and no staged artifact from us. Operator-authored
   * hook configuration is untouched either way.
   */
  ownedCodexBackend?: boolean;
}

/** Fixed, public-safe code of the one owned-mode named-profile refusal. */
export const NATIVE_CODEX_OWNED_PROFILE_UNSUPPORTED_CODE = "owned-codex-named-profile-unsupported";

/**
 * Why an owned Codex backend launch was refused for a target that chooses one
 * of the operator's named provider profiles.
 *
 * A named profile re-scopes the provider's own configuration, and this host
 * does not route profile-scoped configuration into a separate owned backend
 * process; dropping the selection would run the operator's default profile
 * while they asked for another one, which is exactly the silent loss this
 * refusal exists to prevent. The ordinary non-owned Codex launch keeps accepting
 * every profile spelling unchanged.
 *
 * The type is closed: its constructor takes no user content, so the message and
 * code can never carry a profile name, path, argument, or environment value.
 */
export class NativeCodexOwnedProfileUnsupportedError extends Error {
  readonly code = NATIVE_CODEX_OWNED_PROFILE_UNSUPPORTED_CODE;

  constructor() {
    super("pi-review-gate: refusing to prepare an owned Codex backend launch because the selected target's configured arguments choose a named provider profile");
    this.name = "NativeCodexOwnedProfileUnsupportedError";
  }
}

/**
 * The lease's private TUI connection material, as returned by the owned backend
 * readiness accessor: the native remote-connection arguments plus the fresh
 * child-only environment that carries the bearer. Both are sensitive and are
 * never logged, stored, or reported by this module.
 */
export interface NativeCodexOwnedTuiConnection {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The prepared rendering plan of one owned Codex backend launch.
 *
 * It renders the two children of one launch from the facts resolved once by
 * this module — the canonical executable, the canonical workspace, the
 * validated operator argv and its real-option-position scan, and the outcome of
 * this launch's single hook preparation — and it does nothing else: no spawn,
 * no endpoint choice, no token, no RPC, no lease, no artifact, and no provider
 * configuration read or write. Rendering is pure and repeatable, so re-rendering
 * restages nothing and never mutates any input.
 */
export interface NativeCodexOwnedLaunchPlan {
  /**
   * The backend child's base environment: the same sanitized operator
   * environment the TUI child starts from — same `CODEX_HOME`, same native
   * inheritance, same canonical `PWD` — without the host-imposed clipboard
   * marker (which belongs to the interactive TUI only) and without the hook
   * bootstrap marker (which only the backend's own hook channel needs, and which
   * `renderBackend` applies). It carries no bearer and is never mutated.
   */
  readonly backendEnv: NodeJS.ProcessEnv;
  /**
   * Render the backend descriptor from the lease's CLOSED control argv: the
   * `app-server` subcommand, its loopback `--listen` URL, its
   * `capability-token` authentication mode, and the token's SHA-256 digest. Any
   * other list is refused. The digest is the only secret material that reaches
   * the backend, and it arrives in the owner-generated arguments only.
   *
   * The operator's own global configuration and feature options — `-c`/`--config`
   * and `--enable`/`--disable`, each with its exact configured spelling and
   * value, in configured order — are re-emitted in valid native global option
   * position ahead of the subcommand, followed by this launch's prepared
   * SessionStart hook override, so the core that executes hooks and MCP servers
   * sees the configuration the operator chose. Runtime-only options (`-m` and
   * friends) are not app-server arguments and stay on the TUI, whose native
   * protocol projects them.
   *
   * The rendered command line always starts with the same program the TUI
   * launches, and with that program's own configured argv ahead of the
   * provider's options — the script of a `node wrapper.js <provider args>`
   * target included — so the backend is the operator's own launch command put
   * into app-server mode, never a bare interpreter invocation that lost its
   * wrapper. A command that spells the provider's own executable has no such
   * prefix, and its prompt data stays on the TUI alone.
   */
  renderBackend(controlArgs: readonly string[], environment: NodeJS.ProcessEnv): NativeLaunchDescriptor;
  /**
   * Render the interactive TUI descriptor from one fulfilled lease connection:
   * every allowed operator argument, unchanged and in order, with the private
   * connection arguments inserted in real option position. Only the
   * host-added `--no-daemon` disappears on this branch, because this TUI now
   * attaches to the one owned backend instead of a shared daemon; an operator
   * who configured the flag themselves keeps it. The connection environment is
   * preserved exactly, plus the existing clipboard marker the hosted TUI has
   * always carried and, on Windows, the batch percent carrier.
   *
   * For a launch that carried a private `resumeConversationId`, the same
   * position instead receives the provider's exact resume subcommand with its
   * own remote options — `resume --remote <relay> --remote-auth-token-env <ENV>
   * <uuid>` — so the TUI attaches to the owned backend and opens exactly that
   * conversation. The connection must then be exactly those two remote options;
   * anything else is refused rather than shifting the conversation operand.
   */
  renderTui(connection: NativeCodexOwnedTuiConnection): NativeLaunchDescriptor;
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
    const id = `${NATIVE_CLI_EXTERNAL_TARGET_PREFIX}${agent.id}`;
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

/** One option spelled in real option position, plus whatever value it carries. */
export interface NativeArgOptionOccurrence {
  readonly tokenIndex: number;
  readonly name: string;
  /** The value spelled inside the same token (`--flag=value`, `-cvalue`, `-c=value`). */
  readonly attached?: string;
  /** The following token this option consumed as its operand, when it is value-taking. */
  readonly operand?: string;
}

/**
 * What the ONE argv walk of this module knows about a configured argument list.
 * Exported so the per-launch hook preparation reads the same real-option
 * position facts the argv composition uses, instead of inventing a second
 * parser that could drift from the terminator and operand rules above.
 */
export interface NativeArgPositionScan {
  /** Index of the first `--` terminator, or -1 when the list carries none. */
  readonly terminatorIndex: number;
  /**
   * The index a generated source flag belongs at: before the terminator,
   * before a value-taking option still missing its operand, otherwise last.
   */
  readonly insertionIndex: number;
  /** Every option in real option position, in argv order. */
  readonly options: readonly NativeArgOptionOccurrence[];
}

/** Validate the shared args once, and report the positions the provider gives them. */
export function scanNativeArgPositions(
  backend: NativeCliBackend,
  args: readonly string[],
  targetId: string,
): NativeArgPositionScan {
  const policy = backend === "claude" ? CLAUDE_ARGUMENT_POLICY : CODEX_ARGUMENT_POLICY;
  const rejected = (category: RejectionCategory, option: string): never => {
    throw refuse(`target "${targetId}" cannot start a native interactive session because its shared args include the ${category} option ${option}`);
  };
  const occurrences: {
    tokenIndex: number;
    name: string;
    attached?: string;
    operand?: string;
  }[] = [];
  // The provider's own option boundary. Everything after a `--` is prompt data
  // for the provider, so it is forwarded exactly and never read as an option,
  // a subcommand, or a reason to refuse; our own option has to precede it.
  let terminatorIndex = -1;
  // True while the next token is the operand of a documented value-taking option.
  let pendingOperand = false;
  // The index of that pending option, or -1. The isolation flag must never land
  // where the provider would read it as another option's operand.
  let pendingOperandIndex = -1;
  // Set once the terminator is seen: the terminator position, or the pending
  // option a bare `--` would have served as the operand of.
  let terminatorInsertionIndex = -1;
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
    // Past the terminator the provider never parses options, so a token that
    // merely spells an option or a subcommand is literal prompt text: refusing
    // it would drop the operator's own prompt, and re-reading it as an option
    // would be a second, invented parser. Only the first `--` is the boundary.
    if (terminatorIndex !== -1) continue;
    if (arg === "--") {
      terminatorIndex = index;
      // A `--` that is still expected as an option's operand is data, so the
      // flag goes before the option that would otherwise swallow it.
      terminatorInsertionIndex = pendingOperandIndex >= 0 ? pendingOperandIndex : index;
      pendingOperand = false;
      continue;
    }
    if (pendingOperand) {
      // A documented option's operand is data: never a subcommand.
      const pending = occurrences[occurrences.length - 1];
      if (pending !== undefined && pending.tokenIndex === pendingOperandIndex) pending.operand = arg;
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
    if (option.attached === undefined && policy.valueOptions.includes(option.name)) {
      pendingOperand = true;
      pendingOperandIndex = index;
    }
    occurrences.push({
      tokenIndex: index,
      name: option.name,
      ...(option.attached === undefined ? {} : { attached: option.attached }),
    });
  }
  return {
    terminatorIndex,
    insertionIndex: terminatorIndex !== -1
      ? terminatorInsertionIndex
      : (pendingOperandIndex >= 0 ? pendingOperandIndex : args.length),
    options: occurrences.map((occurrence) => ({ ...occurrence })),
  };
}

/**
 * Compose the exact interactive argv from that one scan. `sourceFlags` are the
 * generated provider flags of an explicitly armed hook preparation; they land
 * in the same real option position as the daemon isolation flag, before any
 * terminator or pending operand, and never move or drop an operator token. An
 * empty list — every launch with no hook option — composes exactly what this
 * function composed before hook support existed. `restoreArgs` are the
 * validated restoration tokens of a launch that carried a private resume id;
 * they follow every other generated token in that same position, and an empty
 * list — every fresh launch — changes nothing.
 */
function composeNativeArgs(
  backend: NativeCliBackend,
  args: readonly string[],
  targetId: string,
  sourceFlags: readonly string[] = [],
  restoreArgs: readonly string[] = [],
): string[] {
  const scan = scanNativeArgPositions(backend, args, targetId);
  const argv = [...args];
  // Only an option spelled in real option position isolates the daemon.
  const daemonIsolationActive = scan.options.some(
    (option) => option.attached === undefined && option.name === CODEX_NO_DAEMON_ARG,
  );
  const generated: string[] = [];
  if (backend === "codex" && !daemonIsolationActive) generated.push(CODEX_NO_DAEMON_ARG);
  generated.push(...sourceFlags);
  generated.push(...restoreArgs);
  if (generated.length === 0) return argv;
  argv.splice(scan.insertionIndex, 0, ...generated);
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
 *
 * The value is a parameter only so the owned backend plan can hand this same
 * key back its operator's own value (`readCodexTerminalClipboardMode`), which
 * is a preserved inherited setting rather than the host-imposed mode. Every
 * existing caller passes no value and gets the host-owned `1`.
 */
function applyCodexTerminalClipboardMode(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  value: string = CODEX_TERMINAL_CLIPBOARD_VALUE,
): void {
  if (platform === "win32") {
    for (const name of Object.keys(env)) {
      if (name !== CODEX_TERMINAL_CLIPBOARD_ENV && name.toUpperCase() === CODEX_TERMINAL_CLIPBOARD_ENV) {
        delete env[name];
      }
    }
  }
  env[CODEX_TERMINAL_CLIPBOARD_ENV] = value;
}

/**
 * The value one environment already carries for the clipboard marker key, read
 * with the same spelling rule `applyCodexTerminalClipboardMode` writes with, or
 * `undefined` when it carries no spelling of the key at all. Only the
 * `undefined` case means a later `1` is a host-imposed addition: an existing
 * value is the operator's own setting, and a child that must not gain the host
 * mode still keeps it verbatim.
 */
function readCodexTerminalClipboardMode(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): string | undefined {
  const canonical = environment[CODEX_TERMINAL_CLIPBOARD_ENV];
  if (canonical !== undefined) return canonical;
  if (platform !== "win32") return undefined;
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase() === CODEX_TERMINAL_CLIPBOARD_ENV) return environment[name];
  }
  return undefined;
}

/**
 * Drop every spelling of the clipboard marker key a composed environment now
 * holds, leaving every other entry exactly as it was. Windows resolves one name
 * case-insensitively, so every alias goes too; POSIX names are case-sensitive,
 * so an operator's differently-cased variable of the same letters survives.
 */
function deleteCodexTerminalClipboardMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  for (const name of Object.keys(env)) {
    const matches = platform === "win32"
      ? name.toUpperCase() === CODEX_TERMINAL_CLIPBOARD_ENV
      : name === CODEX_TERMINAL_CLIPBOARD_ENV;
    if (matches) delete env[name];
  }
}

/**
 * Apply one fresh native hook bootstrap marker to a composed CHILD
 * environment, in place, after the shared sanitizer and after the configured
 * target overlay merged.
 *
 * Ordering is the whole point. The sanitizer strips the marker from the
 * inherited environment and from the overlay, so the only spelling that can
 * exist here is one this host owns; writing the fresh value last means a stale
 * marker from an older launch, or a configured alias, can never authenticate a
 * relay. Windows environment names are case-insensitive, so any other spelling
 * is dropped first and the child resolves exactly one canonical entry — the
 * same single-spelling invariant the clipboard marker above keeps.
 *
 * Scope is exactly the names the preparation handed back (today: the one
 * marker). Nothing else in the composed environment is read or changed, and
 * the caller's request object, the launcher options, and the host process
 * environment are never touched.
 */
function applyNativeHookBootstrapEnvironment(
  env: NodeJS.ProcessEnv,
  entries: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): void {
  for (const [name, value] of Object.entries(entries)) {
    if (typeof value !== "string" || containsControlCharacter(name) || containsControlCharacter(value)) {
      throw refuse("a native hook environment entry is not a printable string");
    }
    if (platform === "win32") {
      for (const existing of Object.keys(env)) {
        if (existing !== name && existing.toUpperCase() === name.toUpperCase()) delete env[existing];
      }
    }
    env[name] = value;
  }
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
 * The closed Codex global options whose configuration semantics the owned
 * backend process must receive. These are the provider's own configuration and
 * feature channels: `-c`/`--config` writes a configuration override and
 * `--enable`/`--disable` selects a feature flag, and both are read by the core
 * — which under an owned launch is the app-server child, not the TUI client.
 * Every other allowed operator option is either runtime UI state the native
 * protocol projects (a model choice, an attached image) or already refused by
 * the shared argv policy, so nothing here is a new permission or a new drop.
 */
const CODEX_BACKEND_CONFIG_OPTIONS: readonly string[] = ["-c", "--config", "--enable", "--disable"];

/**
 * The closed Codex spellings that select one of the operator's named provider
 * profiles. They are matched only as canonical option names from the ONE argv
 * scan — never as a substring of a value — so `-c profile=x` stays an ordinary
 * configuration override and a `--profile` past the `--` terminator stays
 * literal prompt data.
 */
const CODEX_NAMED_PROFILE_OPTIONS: readonly string[] = ["-p", "--profile"];

/**
 * The fixed prefix of the owned backend's control argv. It mirrors the closed
 * list the owned backend lease generates in `native-codex-backend.ts`: the
 * `app-server` subcommand, its ephemeral loopback listen URL, and its
 * capability-token authentication mode. This launcher renders that list rather
 * than generating it, so it validates it against these literals instead of
 * splicing whatever it is handed.
 */
const OWNED_BACKEND_CONTROL_PREFIX: readonly string[] = [
  "app-server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-sha256",
];

/** The control argv's trailing operand: a lowercase SHA-256 digest, and nothing else. */
const OWNED_BACKEND_TOKEN_DIGEST = /^[0-9a-f]{64}$/u;

/**
 * Whether a configured command spells the provider's OWN executable — a direct
 * native invocation — rather than some other program that carries its own argv
 * ahead of the provider's (the documented `node wrapper.js <provider args>`
 * shape). The test is on the operator's own declared command: its final path
 * component is the backend's command word, with or without a native executable
 * extension.
 *
 * This is the whole distinction, and it is deliberately not an interpreter
 * allowlist: `node`, `bun`, `python`, or any custom launcher is simply "not the
 * provider's own executable", and gets its configured leading argv preserved on
 * both children. What it settles is the one question the owned split cannot ask
 * the argv itself — whether a bare positional is the provider's prompt (which
 * belongs to the interactive TUI alone) or an argument of the program being
 * launched (which both children need).
 */
const DIRECT_PROVIDER_COMMAND: Readonly<Record<NativeCliBackend, RegExp>> = {
  claude: /(?:^|[/\\])claude(?:\.(?:exe|cmd|bat))?$/iu,
  codex: /(?:^|[/\\])codex(?:\.(?:exe|cmd|bat))?$/iu,
};

/**
 * Where the provider's own argv begins inside a configured argument list: the
 * one program-prefix rule shared by the owned backend split and restoration.
 *
 * A direct provider executable owns no argv of its own, so nothing ahead of
 * its first option is a program prefix: those tokens are its prompt. Any other
 * program keeps the configured tokens ahead of the provider's option parsing,
 * exactly as the TUI receives them.
 */
function nativeProgramArgvStart(
  backend: NativeCliBackend,
  command: string,
  scan: NativeArgPositionScan,
  argsLength: number,
): number {
  return DIRECT_PROVIDER_COMMAND[backend].test(command)
    ? 0
    : (scan.options.length > 0
      ? scan.options[0].tokenIndex
      : (scan.terminatorIndex !== -1 ? scan.terminatorIndex : argsLength));
}

/**
 * Configured options that can carry startup INPUT into the first turn, which a
 * restored conversation must never receive again. Restoration refuses them in
 * real option position (any spelling) rather than proving they do not submit,
 * and a fresh launch never consults this list. Claude `--file` downloads file
 * resources into the startup; Codex `-i`/`--image` attaches images to the
 * initial prompt.
 */
const NATIVE_RESTORE_INPUT_OPTIONS: Readonly<Record<NativeCliBackend, readonly string[]>> = {
  claude: ["--file"],
  codex: ["-i", "--image"],
};

/**
 * Configured options that would let the provider pick a DIFFERENT conversation
 * than the exact restored one. Claude `--from-pr` resumes a pull-request-linked
 * session or opens a picker; combined with `--resume <uuid>` the outcome would
 * no longer be one proven conversation. Restoration only; a fresh launch never
 * consults this list.
 */
const NATIVE_RESTORE_SELECTION_OPTIONS: Readonly<Record<NativeCliBackend, readonly string[]>> = {
  claude: ["--from-pr"],
  codex: [],
};

/** The exact Codex subcommand word of a native resume. */
const CODEX_RESUME_SUBCOMMAND = "resume";

/** Claude's documented exact-resume option. */
const CLAUDE_RESUME_OPTION = "--resume";

/** The two remote options a Codex `resume` subcommand receives from the owned lease, in order. */
const CODEX_REMOTE_CONNECTION_OPTIONS: readonly string[] = ["--remote", "--remote-auth-token-env"];

/** A refusal of one restoration; fixed text that never carries the id, a value, or a path. */
function refuseRestore(targetId: string, reason: string): Error {
  return refuse(`target "${targetId}" cannot restore a native conversation because ${reason}`);
}

/**
 * Claude options whose split operand is system-prompt CONFIGURATION that the
 * shared scanner does not list as value-taking. Restoration alone reads the
 * token after one of these as that option's operand (never as a positional
 * prompt); the fresh scanner, its insertion position, and every fresh launch
 * stay exactly as they were. An occurrence with no usable operand — last in
 * the option area, or followed by an option spelling or `--` — is ambiguous and
 * refuses the restore instead of letting the restoration tokens become its value.
 */
/**
 * The one supported script-consuming interpreter command shape a restore
 * accepts a program prefix for: `node`, optionally `.exe`, by its final path
 * component. Restoration only; fresh composition never consults it.
 */
const NODE_INTERPRETER_COMMAND = /(?:^|[/\\])node(?:\.exe)?$/iu;

const NATIVE_RESTORE_CONFIG_VALUE_OPTIONS: Readonly<Record<NativeCliBackend, readonly string[]>> = {
  claude: ["--system-prompt"],
  codex: [],
};

/**
 * Prove that a configured argument list carries no startup input before a
 * restoration composes it, using the ONE scan's real option positions.
 *
 * Restoration refuses — never strips or rewrites — every token the provider
 * would read as user input: every token past a `--` terminator, every
 * input-bearing or conversation-selecting option above, and every positional
 * that is not a proven program-prefix token or an option operand. Option
 * operands (`--model x`, `--append-system-prompt …`, `--system-prompt …`,
 * `-c key=value`) are configuration, not input. A bare trailing `--` carries
 * nothing and stays, because the restoration tokens are inserted before it.
 * Configured resume/continue/fork/permission/workspace spellings were already
 * refused by the scan itself and stay refused.
 *
 * The program prefix is PROVED here, not assumed. The fresh owned split treats
 * every positional ahead of a wrapper's first option as the wrapper's own argv,
 * which is a permissive heuristic: a wrapper that forwards its arguments would
 * replay `wrapper.js "initial prompt" --model x`'s prompt, and a passthrough
 * wrapper (`exec claude "$@"`) would forward even a lone existing filename as a
 * prompt. File existence alone therefore proves nothing about how a command
 * consumes its first positional. A restore accepts a program prefix only for
 * the one supported script-consuming interpreter shape, the documented
 * `node wrapper.js <provider args>`: the command is `node` (or `node.exe`), the
 * prefix is exactly ONE leading positional, and it names an existing regular
 * file (absolute, or relative to the workspace the child is spawned in).
 * Anything else — any other wrapper command with a leading positional, a
 * second leading positional, a prefix token that is not an existing file, or
 * any positional after it — is ambiguous and refuses the restore. A direct
 * provider executable has no program prefix at all. All of this is
 * restore-only: fresh composition keeps its existing prefix behavior.
 */
function assertRestorableNativeArgs(
  backend: NativeCliBackend,
  args: readonly string[],
  targetId: string,
  command: string,
  scan: NativeArgPositionScan,
  cwd: string,
): void {
  if (scan.terminatorIndex !== -1 && scan.terminatorIndex < args.length - 1) {
    throw refuseRestore(targetId, "its shared args carry prompt data after the -- terminator, which would be replayed into the restored conversation");
  }
  const optionAreaEnd = scan.terminatorIndex === -1 ? args.length : scan.terminatorIndex;
  const operandIndices = new Set<number>();
  for (const option of scan.options) {
    if (option.operand !== undefined) operandIndices.add(option.tokenIndex + 1);
    if (NATIVE_RESTORE_INPUT_OPTIONS[backend].includes(option.name)) {
      throw refuseRestore(targetId, `its shared args include the startup input option ${option.name}, which cannot be proved not to submit input into the restored conversation`);
    }
    if (NATIVE_RESTORE_SELECTION_OPTIONS[backend].includes(option.name)) {
      throw refuseRestore(targetId, `its shared args include the conversation selection option ${option.name}`);
    }
    if (option.attached === undefined && NATIVE_RESTORE_CONFIG_VALUE_OPTIONS[backend].includes(option.name)) {
      const operandIndex = option.tokenIndex + 1;
      if (operandIndex >= optionAreaEnd || parseOption(args[operandIndex]) !== undefined) {
        throw refuseRestore(targetId, `its shared args spell ${option.name} without a value it can be proved to carry`);
      }
      operandIndices.add(operandIndex);
    }
  }
  const programStart = nativeProgramArgvStart(backend, command, scan, args.length);
  if (programStart > 1) {
    throw refuseRestore(targetId, "its wrapper command carries more than one leading positional, which cannot be proved not to be a forwarded initial prompt");
  }
  if (programStart === 1) {
    // Only the supported Node interpreter shape establishes that the first
    // positional selects a script instead of being forwarded provider input.
    if (!NODE_INTERPRETER_COMMAND.test(command)) {
      throw refuseRestore(targetId, "its wrapper command has no proven script-consuming interpreter prefix");
    }
    const prefix = args[0];
    if (!isUsableRegularFile(isAbsolute(prefix) ? prefix : join(cwd, prefix))) {
      throw refuseRestore(targetId, "its wrapper command's leading positional is not an existing script file, so it cannot be proved not to be a forwarded initial prompt");
    }
  }
  for (let index = programStart; index < optionAreaEnd; index += 1) {
    if (operandIndices.has(index)) continue;
    if (parseOption(args[index]) === undefined) {
      throw refuseRestore(targetId, "its shared args include a positional initial prompt, which would be replayed into the restored conversation");
    }
  }
}

/**
 * Validate the owned lease's connection for a restoration: exactly the Codex
 * `resume` subcommand's two remote options, each with one non-option value.
 * Anything else could consume or shift the conversation operand that follows,
 * so it is refused with fixed text; nothing of it is echoed.
 */
function assertOwnedResumeConnectionArgs(connectionArgs: readonly string[]): void {
  const shaped = connectionArgs.length === CODEX_REMOTE_CONNECTION_OPTIONS.length * 2
    && CODEX_REMOTE_CONNECTION_OPTIONS.every((name, position) => {
      const value = connectionArgs[position * 2 + 1];
      return connectionArgs[position * 2] === name
        && typeof value === "string" && value.length > 0 && !value.startsWith("-");
    });
  if (!shaped) {
    throw refuse("the owned Codex TUI connection is not exactly the resume subcommand's --remote and --remote-auth-token-env options");
  }
}

/**
 * Validate the CLOSED control argv the lease generated. Every message is fixed
 * text: a rejected list is never echoed, because its final operand is the
 * token digest.
 */
function assertOwnedBackendControlArgs(controlArgs: readonly string[]): string[] {
  const malformed = (): never => {
    throw refuse("the owned Codex backend control arguments are not the closed app-server capability-token argv");
  };
  if (!Array.isArray(controlArgs) || controlArgs.length !== OWNED_BACKEND_CONTROL_PREFIX.length + 1) malformed();
  for (let index = 0; index < OWNED_BACKEND_CONTROL_PREFIX.length; index += 1) {
    if (controlArgs[index] !== OWNED_BACKEND_CONTROL_PREFIX[index]) malformed();
  }
  const digest = controlArgs[OWNED_BACKEND_CONTROL_PREFIX.length];
  if (typeof digest !== "string" || !OWNED_BACKEND_TOKEN_DIGEST.test(digest)) {
    throw refuse("the owned Codex backend control arguments do not end in a lowercase SHA-256 token digest");
  }
  return [...controlArgs];
}

/**
 * Validate the lease's private TUI connection material and copy it. The
 * connection arguments are the provider's own remote-attachment options: they
 * are inserted literally, they are never inspected for meaning, and neither
 * they nor the environment is ever logged or reported. A connection with no
 * argument would silently start a TUI attached to nothing, so it is refused.
 */
function assertOwnedTuiConnection(connection: NativeCodexOwnedTuiConnection): { args: string[]; env: NodeJS.ProcessEnv } {
  if (connection === null || typeof connection !== "object" || Array.isArray(connection)) {
    throw refuse("an owned Codex TUI connection object is required");
  }
  const args = (connection as { args?: unknown }).args;
  if (!Array.isArray(args) || args.length === 0
    || args.some((token) => typeof token !== "string" || containsControlCharacter(token))) {
    throw refuse("the owned Codex TUI connection carries no printable connection arguments");
  }
  const env = (connection as { env?: unknown }).env;
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw refuse("the owned Codex TUI connection carries no environment");
  }
  return { args: [...args] as string[], env: { ...(env as NodeJS.ProcessEnv) } };
}

/** What one owned Codex launch resolved once, before any environment or artifact work. */
interface OwnedCodexLaunchFacts {
  /** The ONE argv scan the plan's TUI renderer inserts the connection into. */
  readonly scan: NativeArgPositionScan;
  /**
   * The configured tokens that sit ahead of the provider's own option parsing:
   * the launch command's own argv, such as the script of a documented
   * `node wrapper.js <provider args>` target. The backend runs the SAME resolved
   * program as the TUI, so it receives this prefix unchanged and in order;
   * without it a wrapper target would exec the interpreter with bare provider
   * arguments and never start the intended backend.
   *
   * Empty for a command that spells the provider's own executable: a direct
   * native invocation has no argv of its own to carry, so every positional in
   * its configured args is the provider's prompt and stays on the TUI alone.
   */
  readonly programPrefixArgs: readonly string[];
  /** The operator's global configuration and feature tokens, in configured order. */
  readonly backendConfigArgs: readonly string[];
}

/**
 * Read the configured argv once for an owned Codex launch, refusing before the
 * environment clone, the hook preparation, any artifact, and any process.
 *
 * A named profile is refused outright rather than forwarded or dropped: this
 * host does not route profile-scoped provider configuration into a separate
 * owned backend, so forwarding it would leave the TUI's core on one profile and
 * the backend that actually executes hooks and MCP servers on another, and
 * dropping it would run the operator's default profile while they asked for a
 * named one. The refusal is the typed, code-carrying, content-free
 * `NativeCodexOwnedProfileUnsupportedError`, so the owner maps it through its
 * existing sanitizing error lanes; every other failure keeps its existing
 * sanitization.
 *
 * The same scan yields the backend's global configuration block. A value-taking
 * option that carries no value cannot be placed ahead of the backend
 * subcommand — the subcommand word would become its operand — so that
 * malformed spelling refuses clearly instead of rendering a shifted command.
 *
 * The same scan also fixes the launch command's own prefix: the configured
 * tokens before the first real option, which is exactly where the documented
 * wrapper shape puts its own argv (`node wrapper.js -c key=value`). Positionals
 * at or after that first option, and everything past a `--` terminator, are the
 * provider's own prompt data and stay on the TUI alone, so no prompt ever
 * reaches the backend. A command that spells the provider's own executable
 * (`codex`, `/usr/local/bin/codex`, `codex.cmd`) has no program prefix at all,
 * so its leading positional — the provider's prompt, whether or not configuration
 * options follow it — is TUI-only data and the backend stays the closed
 * app-server invocation.
 *
 * What remains genuinely ambiguous is reported rather than guessed: a custom
 * program whose final path component happens to spell the provider's word while
 * actually being a wrapper, or an interpreter whose leading argv mixes its own
 * arguments with forwarded prompt text. This launcher never refuses for either
 * shape and never inspects the program beyond the operator's declared command.
 */
function prepareOwnedCodexLaunchFacts(
  backend: NativeCliBackend,
  args: readonly string[],
  targetId: string,
  command: string,
): OwnedCodexLaunchFacts {
  const scan = scanNativeArgPositions(backend, args, targetId);
  if (scan.options.some((option) => CODEX_NAMED_PROFILE_OPTIONS.includes(option.name))) {
    throw new NativeCodexOwnedProfileUnsupportedError();
  }
  const programArgvStart = nativeProgramArgvStart(backend, command, scan, args.length);
  const backendConfigArgs: string[] = [];
  for (const option of scan.options) {
    if (!CODEX_BACKEND_CONFIG_OPTIONS.includes(option.name)) continue;
    const token = args[option.tokenIndex];
    if (typeof token !== "string") {
      throw refuse("an owned Codex backend configuration option has no configured token");
    }
    backendConfigArgs.push(token);
    if (option.attached !== undefined) continue;
    if (option.operand === undefined || args[option.tokenIndex + 1] !== option.operand) {
      throw refuse("an owned Codex backend configuration or feature option is configured without a value");
    }
    backendConfigArgs.push(option.operand);
  }
  return { scan, programPrefixArgs: args.slice(0, programArgvStart), backendConfigArgs };
}

/**
 * The base environment of one owned backend child: the same sanitized operator
 * environment the TUI child starts from, so `CODEX_HOME` and every other native
 * setting resolve identically in both processes, minus the clipboard marker the
 * host imposes on the interactive TUI alone. An operator's own value for that
 * key is not a host imposition and is preserved exactly.
 *
 * The clone is taken before this launch's hook bootstrap marker is written to
 * the TUI environment: the marker belongs where the hook command runs, and
 * `renderBackend` applies it to the environment the lease hands back.
 */
function ownedCodexBackendEnvironment(
  composed: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  operatorClipboardValue: string | undefined,
): NodeJS.ProcessEnv {
  const backendEnv = { ...composed };
  if (operatorClipboardValue === undefined) deleteCodexTerminalClipboardMode(backendEnv, platform);
  else applyCodexTerminalClipboardMode(backendEnv, platform, operatorClipboardValue);
  return backendEnv;
}

/** Everything one owned Codex plan needs; the caller owns every field. */
interface OwnedCodexLaunchPlanInput {
  readonly file: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly facts: OwnedCodexLaunchFacts;
  readonly platform: NodeJS.Platform;
  readonly parentEnvironment: NodeJS.ProcessEnv;
  readonly backendEnv: NodeJS.ProcessEnv;
  /** The hook flags this launch's ONE preparation produced, empty when it armed nothing. */
  readonly hookArgs: readonly string[];
  /** The hook marker entries of that same preparation, empty when it armed nothing. */
  readonly hookEnvironment: Readonly<Record<string, string>>;
  /**
   * The native MCP relay flags this launch's ONE preparation produced for the
   * owned backend, empty when it armed nothing. They carry no secret.
   */
  readonly mcpArgs?: readonly string[];
  /**
   * The validated private restoration id of this launch, absent for a fresh
   * launch. Held in the TUI renderer's closure only: never a plan field, never
   * part of the backend render.
   */
  readonly resumeConversationId?: string;
  /**
   * The trailing `-- <instruction>` of a fresh SessionSpawn startup request, empty
   * otherwise. Appended to the TUI render only: the backend never receives it.
   */
  readonly initialPromptOperandArgs?: readonly string[];
}

/**
 * Build the plan of one owned Codex launch. Every fact is already resolved and
 * every artifact already staged by the ordinary preparation, so both renderers
 * are pure re-compositions of literal tokens: they stage nothing, spawn nothing,
 * mutate nothing they were given, and repeat identically.
 *
 * The Windows branch is the same trusted batch path the ordinary descriptor
 * uses, fed complete literal argv each time. It never re-quotes or appends to a
 * previously rendered `commandLine`, so `/d /s /v:off /c "…"`, the one percent
 * carrier, and the trusted parent `cmd.exe` stay exactly the established
 * convention for both children.
 */
function createOwnedCodexLaunchPlan(input: OwnedCodexLaunchPlanInput): NativeCodexOwnedLaunchPlan {
  const {
    file, cwd, args, facts, platform, parentEnvironment, backendEnv, hookArgs, hookEnvironment, resumeConversationId,
    initialPromptOperandArgs = [], mcpArgs = [],
  } = input;
  const render = (argv: readonly string[], env: NodeJS.ProcessEnv): NativeLaunchDescriptor => {
    if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      const batch = adaptWindowsBatchShim(file, argv, parentEnvironment, env);
      return { file: batch.file, args: batch.args, commandLine: batch.commandLine, env: batch.env, cwd };
    }
    return { file, args: [...argv], env, cwd };
  };
  return {
    backendEnv,
    renderBackend: (controlArgs, environment) => {
      const control = assertOwnedBackendControlArgs(controlArgs);
      if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
        throw refuse("the owned Codex backend environment is required");
      }
      const env = { ...environment };
      // The hook channel and its marker belong to this child alone: the core
      // that runs the provider's hooks and MCP servers is the backend.
      applyNativeHookBootstrapEnvironment(env, hookEnvironment, platform);
      // Same program, same configured argv prefix, then the provider's global
      // configuration, then this launch's hook channel, then this launch's MCP
      // relay override (after the operator's own `-c` tokens, which it was
      // already proved not to collide with), then the app-server control argv.
      // Prompt and runtime-only arguments never cross over.
      return render([...facts.programPrefixArgs, ...facts.backendConfigArgs, ...hookArgs, ...mcpArgs, ...control], env);
    },
    renderTui: (connection) => {
      const { args: connectionArgs, env } = assertOwnedTuiConnection(connection);
      // The hosted TUI keeps the clipboard marker it has always carried; the
      // connection environment it arrives in is otherwise preserved exactly.
      applyCodexTerminalClipboardMode(env, platform);
      const insertion = facts.scan.insertionIndex;
      // A restoration renders the provider's exact resume subcommand in the same
      // real option position: every configured (already proved input-free)
      // global option ahead of it, the subcommand's own remote options, then the
      // one exact conversation operand. No prompt operand ever follows it.
      let inserted = connectionArgs;
      if (resumeConversationId !== undefined) {
        assertOwnedResumeConnectionArgs(connectionArgs);
        inserted = [CODEX_RESUME_SUBCOMMAND, ...connectionArgs, resumeConversationId];
      }
      // A fresh startup request's prompt operand follows everything, after its own
      // `--` terminator, exactly as on the ordinary descriptor.
      const argv = [...args.slice(0, insertion), ...inserted, ...args.slice(insertion), ...initialPromptOperandArgs];
      return render(argv, env);
    },
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
 * - Only a launcher constructed with `ownedCodexBackend: true` attaches a
 *   `NativeCodexOwnedLaunchPlan` to a Codex result, and it attaches nothing to
 *   any other backend. The mode changes no resolution, no guard, and no
 *   descriptor: it adds one preparation-only plan, one new refusal — a
 *   configured named profile, which this host cannot route to an owned backend —
 *   and the decline of this module's OWN status-hook preparation for exactly those
 *   planned Codex launches, so their real argv and environment carry no hook of
 *   ours while every operator-configured flag survives.
 */
export function createNativeCliLauncher(
  config: ReviewGateConfig,
  options: NativeCliLauncherOptions = {},
): NativeCliLauncher {
  if (options.ownedCodexBackend !== undefined && typeof options.ownedCodexBackend !== "boolean") {
    throw refuse("the owned Codex backend launcher option must be a boolean or absent");
  }
  const ownedCodexBackend = options.ownedCodexBackend === true;
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

    // Owned Codex backend mode reads the configured argv once, here, before the
    // environment clone, the hook preparation, any artifact, and any process:
    // the profile refusal must cost nothing, and the plan's renderers need the
    // same real-option-position facts this module's ONE scanner produces. A
    // Claude launch never enters this branch, so the mode attaches no plan and
    // changes nothing about it.
    const ownedFacts = ownedCodexBackend && backend === "codex"
      ? prepareOwnedCodexLaunchFacts(backend, args, target.id, command)
      : undefined;

    // Private restoration intent: validated here, still before the environment
    // clone, the hook preparation, any artifact, and any process, so a refusal
    // stages nothing and reaches the caller's ordinary launch failure path. An
    // absent id leaves every step below exactly as a fresh launch composes it.
    let restoreArgs: readonly string[] = [];
    const resumeConversationId = request.resumeConversationId;
    if (resumeConversationId !== undefined) {
      if (!isNativeConversationId(resumeConversationId)) {
        throw refuse("the native conversation restore id is not one exact provider conversation UUID");
      }
      // A restore is the remembered target or nothing: the default target is
      // never substituted for a missing identity.
      if (targetId === undefined) {
        throw refuse("a native conversation restore requires its exact remembered launch target");
      }
      if (backend === "codex" && ownedFacts === undefined) {
        // Only the owned plan's remote resume form is the proven Codex restore.
        throw refuseRestore(target.id, "an ordinary (non-owned) Codex launch has no proven exact resume form; it is refused rather than started fresh");
      }
      const scan = ownedFacts?.scan ?? scanNativeArgPositions(backend, args, target.id);
      // The restore's program-prefix proof reads the workspace the child is
      // spawned in; the same canonicalization runs again below, unchanged.
      assertRestorableNativeArgs(backend, args, target.id, command, scan, canonicalNativeWorkspace(request.workspace));
      if (backend === "codex") {
        // The owned TUI attaches to its own backend over `--remote`, which an
        // operator-configured daemon isolation flag contradicts; it is refused,
        // never silently dropped.
        if (scan.options.some((option) => option.name === CODEX_NO_DAEMON_ARG)) {
          throw refuseRestore(target.id, `its shared args include ${CODEX_NO_DAEMON_ARG}, which a remote resume of the owned backend cannot combine with`);
        }
        // The ordinary descriptor of an owned launch is never what the owner
        // spawns (it spawns `renderTui`), but it still names this exact
        // conversation so it can never describe a fresh one.
        restoreArgs = [CODEX_RESUME_SUBCOMMAND, resumeConversationId];
      } else {
        restoreArgs = [CLAUDE_RESUME_OPTION, resumeConversationId];
      }
    }

    // Fresh SessionSpawn startup request: validated here, before the environment
    // clone, the hook preparation, any artifact, and any process. It is a fresh
    // conversation by definition, so it is never combined with a restoration.
    let initialPromptArgs: { readonly optionArgs: readonly string[]; readonly operandArgs: readonly string[] } | undefined;
    if (request.initialPrompt !== undefined) {
      if (resumeConversationId !== undefined) {
        throw refuse("a native startup request cannot be combined with a conversation restore");
      }
      initialPromptArgs = nativeInitialPromptArgs(
        backend,
        request.initialPrompt,
        target.id,
        target.id === NATIVE_CLI_DEFAULT_TARGET_IDS[backend] && args.length === 0,
      );
    }

    // Owner-supplied native MCP relay: the option's shape and its bootstrap's
    // backend are validated here, before the environment clone, the hook
    // preparation, any artifact, and any process, so a malformed or
    // cross-backend request stages nothing at all.
    let mcpBootstrap: NativeMcpBootstrap | undefined;
    let mcpServerName: string | undefined;
    if (request.nativeMcp !== undefined) {
      const option: unknown = request.nativeMcp;
      const record = option !== null && typeof option === "object" && !Array.isArray(option)
        ? option as { bootstrap?: unknown; serverName?: unknown }
        : undefined;
      const candidate = record?.bootstrap;
      mcpBootstrap = parseNativeMcpBootstrap(candidate);
      if (mcpBootstrap === undefined) {
        throw refuse("the native MCP launch option must carry the broker's native MCP bootstrap object");
      }
      if (mcpBootstrap.backend !== backend) {
        throw refuse(`the native MCP bootstrap is registered for ${mcpBootstrap.backend} and cannot arm a ${backend} launch`);
      }
      const serverName = record?.serverName;
      if (!isValidNativeMcpServerName(serverName)) {
        throw refuse(`the native MCP launch option must carry the stable host MCP server name ("${NATIVE_MCP_SERVER_NAME_PREFIX}" followed by ${NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH} lowercase hexadecimal digits)`);
      }
      mcpServerName = serverName;
    }

    // The child environment first, so a configured PATH override is the PATH
    // discovery actually searches (same rule the settings availability probe
    // applies) and the located file is the file the child would execute.
    const env = composeNativeEnvironment(request.env, sharedEnv, platform);
    // Whether this environment already carries the clipboard marker is observed
    // before the host mode wins the key: only an absent key means a later `1`
    // is host-imposed. Every other launch behavior is untouched.
    const operatorClipboardValue = backend === "codex"
      ? readCodexTerminalClipboardMode(env, platform)
      : undefined;
    // The Codex clipboard compatibility marker is applied to the composed child
    // environment only, once normal target and environment resolution is done,
    // so it wins for this one variable over any configured or inherited value
    // while leaving the rest of the composition untouched (Claude and Pi
    // descriptors receive nothing).
    if (backend === "codex") applyCodexTerminalClipboardMode(env, platform);
    const cwd = canonicalNativeWorkspace(request.workspace);
    env.PWD = cwd;
    // Cloned now, so the backend base environment carries the operator's
    // composition and never this launch's hook marker, which is written to the
    // TUI environment below and to the backend only at render time.
    const ownedBackendEnv = ownedFacts === undefined
      ? undefined
      : ownedCodexBackendEnvironment(env, platform, operatorClipboardValue);
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

    // Owner-supplied native status hooks. This runs only when the request
    // explicitly armed them, and only after the shared sanitizer already
    // rejected a worker role, so no artifact is ever staged for a delegated
    // worker. The generated flags are composed into argv HERE — before the
    // Windows batch escaping below — so they are quoted by the one cmdQuote
    // authority like every other token, and the batch percent carrier still
    // covers them. The fresh marker is written after the sanitizer and after
    // the target overlay for the same reason.
    //
    // An OWNED Codex launch is the one launch this module declines to prepare a
    // hook for, and that is decided by this launcher's own construction
    // (`ownedCodexBackend: true`) — not by a new mode, flag, request field, or
    // provider control. The owning host already owns the app-server backend
    // beside this row's TUI, and the approved relay and its read-only RPC are
    // that row's metadata channel; a hook instruction this host injected into the
    // interactive child would be a second, competing channel whose only effect is
    // to change the real launch argv and environment. So an armed bootstrap is
    // still shape-validated here — a malformed option stays the same programming
    // error it always was, and the named-profile refusal still wins over it — but
    // nothing is acquired: no artifact, no lease, no generated flag in argv, no
    // marker in either child's environment, and `nativeHook` stays absent, which
    // the manager already reads as "this run keeps its source and observer and
    // stays unknown" rather than as a refusal. What an operator configured for
    // themselves — every `-c`/`--config` hook spelling, feature flag, and their
    // own `hooks.SessionStart` override — is composed by the ONE scanner above and
    // reaches both children exactly as before; only this host's own instruction is
    // withheld.
    let nativeHook: NativeHookLaunchOutcome | undefined;
    if (request.nativeHook !== undefined) {
      const bootstrap = (request.nativeHook as { bootstrap?: unknown }).bootstrap;
      if (bootstrap === null || typeof bootstrap !== "object") {
        throw refuse("the native hook launch option must carry the broker's native hook bootstrap object");
      }
      if (ownedFacts === undefined) {
        const scan = scanNativeArgPositions(backend, args, target.id);
        nativeHook = await prepareNativeHookLaunch({
          backend,
          bootstrap: bootstrap as NativeHookBootstrap,
          platform,
          args,
          scan,
          env,
          ...(platform === "win32"
            ? { windowsCommandQuoter: (token: string): string => loadLauncherHelpers().cmdQuote(token) }
            : {}),
        });
        if (nativeHook.observation === "prepared") {
          applyNativeHookBootstrapEnvironment(env, nativeHook.environment, platform);
        }
      }
    }

    // Owner-supplied native MCP relay (#682). Runs only when the request armed
    // it, after the shared sanitizer rejected a worker role. Claude flags join
    // the descriptor argv in the same real option position as the hook flags;
    // owned Codex flags go to the backend render ONLY; a non-owned Codex launch
    // and Windows are declined without staging anything. A refusal here rolls
    // back this launch's hook artifacts before it propagates.
    let nativeMcp: NativeMcpLaunchOutcome | undefined;
    if (mcpBootstrap !== undefined && mcpServerName !== undefined) {
      try {
        nativeMcp = await prepareNativeMcpLaunch({
          backend,
          bootstrap: mcpBootstrap,
          platform,
          scan: ownedFacts?.scan ?? scanNativeArgPositions(backend, args, target.id),
          env,
          ownedCodexBackend: ownedFacts !== undefined,
          serverName: mcpServerName,
        });
      } catch (error) {
        if (nativeHook !== undefined && nativeHook.observation === "prepared") {
          await nativeHook.lease.cleanup().catch(() => undefined);
        }
        throw error;
      }
    }
    const preparedMcp = nativeMcp !== undefined && nativeMcp.mcp === "prepared" ? nativeMcp : undefined;

    // Everything after a successful preparation can still fail — a Windows
    // batch child needs a trusted cmd.exe, and descriptor construction has no
    // further authority of its own. The caller receives either the descriptor
    // (and with it ownership of the lease) or nothing, so a failure here must
    // roll the staged artifacts back instead of orphaning them.
    try {
      const argv = composeNativeArgs(
        backend,
        args,
        target.id,
        [
          ...(nativeHook !== undefined && nativeHook.observation === "prepared" ? nativeHook.args : []),
          ...(preparedMcp !== undefined && preparedMcp.placement === "claude-tui" ? preparedMcp.args : []),
        ],
        // A startup title option rides in the same real option position as every
        // other generated token; the instruction is the trailing prompt operand.
        [...restoreArgs, ...(initialPromptArgs?.optionArgs ?? [])],
      );
      if (initialPromptArgs !== undefined) argv.push(...initialPromptArgs.operandArgs);
      const ownedCodex = ownedFacts === undefined || ownedBackendEnv === undefined
        ? undefined
        : createOwnedCodexLaunchPlan({
          file,
          cwd,
          args,
          facts: ownedFacts,
          platform,
          parentEnvironment: options.parentEnvironment ?? process.env,
          backendEnv: ownedBackendEnv,
          // An owned plan is built ONLY where `ownedFacts` exists, and that is exactly
          // where this module declined its own hook preparation above — so the hook
          // channel this render would otherwise merge is structurally empty: neither
          // rendered child ever receives a generated flag or a bootstrap marker. The
          // operator's own configuration and hook tokens are already inside
          // `facts.backendConfigArgs` and `args`, composed by the one scanner.
          hookArgs: [],
          hookEnvironment: {},
          // The MCP relay override belongs to the core that starts MCP servers:
          // the owned backend, never the TUI render or the ordinary descriptor.
          mcpArgs: preparedMcp !== undefined && preparedMcp.placement === "codex-owned-backend" ? preparedMcp.args : [],
          ...(resumeConversationId === undefined ? {} : { resumeConversationId }),
          ...(initialPromptArgs === undefined ? {} : { initialPromptOperandArgs: initialPromptArgs.operandArgs }),
        });
      if (platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
        const batch = adaptWindowsBatchShim(file, argv, options.parentEnvironment ?? process.env, env);
        return {
          file: batch.file,
          args: batch.args,
          commandLine: batch.commandLine,
          env: batch.env,
          cwd,
          ...(nativeHook === undefined ? {} : { nativeHook }),
          ...(nativeMcp === undefined ? {} : { nativeMcp }),
          ...(ownedCodex === undefined ? {} : { ownedCodex }),
        };
      }
      return {
        file,
        args: argv,
        env,
        cwd,
        ...(nativeHook === undefined ? {} : { nativeHook }),
        ...(nativeMcp === undefined ? {} : { nativeMcp }),
        ...(ownedCodex === undefined ? {} : { ownedCodex }),
      };
    } catch (error) {
      if (nativeHook !== undefined && nativeHook.observation === "prepared") {
        await nativeHook.lease.cleanup().catch(() => undefined);
      }
      if (preparedMcp !== undefined) {
        await preparedMcp.lease.cleanup().catch(() => undefined);
      }
      throw error;
    }
  };
}
