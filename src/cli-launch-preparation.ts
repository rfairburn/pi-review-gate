/**
 * Shared Claude/Codex command launch preparation (#682 / #756).
 *
 * One platform-aware preparation serves every place this extension starts a
 * Claude Code or Codex CLI from a configured command: the native interactive
 * sidebar descriptors (src/session-host/native-cli-launch.ts, including the
 * owned Codex backend/TUI render seam) and the guided external reviewer
 * adapters (src/adapters/claude-cli.ts and src/adapters/codex-cli.ts, which opt
 * in through `runPromptProcess`). Nothing here is a separate Windows
 * architecture: the same three steps run on every platform.
 *
 * 1. **Name check.** A bare command must be one exact filename. A whitespace- or
 *    shell-metacharacter-bearing "name" is a shell command line, and no shell is
 *    ever involved; an explicit path is a whole filename and may legitimately
 *    contain spaces or quotes.
 * 2. **Discovery.** POSIX guided reviewers leave executable lookup to their
 *    direct spawn, so the configured spelling (argv[0], a relative `./wrapper`)
 *    and Node's own search rules (an empty `PATH` entry, the default search
 *    path when `PATH` is unset) are exactly what they were. Native descriptors
 *    and Windows guided reviewers locate the command with the shared
 *    `resolveApplicationCommand` resolver against the child's own environment
 *    and the directory the child runs in. An explicit path is honored exactly
 *    as given. On Windows a bare name selects only native `PATHEXT` candidates,
 *    so an extensionless npm POSIX shell shim installed beside `codex.cmd` is
 *    never selected (see src/application-command.ts).
 * 3. **Rendering.** POSIX and a Windows native executable are a direct argv
 *    spawn: no shell, the argv, environment, and cwd exactly as the caller
 *    composed them. A Windows `.cmd`/`.bat` shim runs
 *    through the parent's trusted `SystemRoot\System32\cmd.exe` with the one
 *    literal batch rendering below — `/d /s /v:off /c "…"`, every token quoted
 *    by the shipped launcher's single `cmdQuote` authority, every percent
 *    delivered through one internal carrier — and is never `shell: true`.
 *
 * Refusals never echo environment values, argument values, or searched paths;
 * a bare command name is echoed, a path is not.
 */
import { statSync } from "node:fs";
import { join, sep } from "node:path";
import { isAbsoluteForPlatform, isWindowsUncPath, resolveApplicationCommand } from "./application-command";

/** Builds the caller's own refusal error from one path-free reason. */
export type LaunchRefusal = (reason: string) => Error;

/** A configured command is echo-able only when it is a bare filename, never a path. */
export function safeCommandLabel(command: string): string {
  return /[/\\]/.test(command) ? "the configured command" : command;
}

/** Control characters can never cross a batch command line (or argv) safely. */
export function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** Whether a command spelling is a bare name (searched on PATH) rather than an explicit path. */
export function isBareCommandName(command: string, platform: NodeJS.Platform): boolean {
  return !command.includes("/") && !(platform === "win32" && command.includes("\\"));
}

/**
 * Refuse a bare command that is really a shell command string. An explicit
 * path is a whole filename and is never refused here.
 */
export function assertSingleExecutableName(
  command: string,
  platform: NodeJS.Platform,
  refuse: LaunchRefusal,
  subject: string,
): void {
  if (typeof command !== "string" || command.length === 0) {
    throw refuse(`${subject} has no configured command`);
  }
  if (isBareCommandName(command, platform) && (/\s/.test(command) || /[|&;$<>()`\\'"]/.test(command))) {
    throw refuse(`${subject} names a shell command string rather than a single executable filename`);
  }
}

/** Whether a located Windows file is a batch shim that only cmd.exe can run. */
export function isWindowsBatchFile(file: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/**
 * Locate the exact file one configured command points at, in the child's
 * environment and run directory, or refuse. The located path is returned as
 * found (not canonicalized); a caller that needs a cwd-independent descriptor
 * canonicalizes it itself.
 */
export async function locateCliExecutable(input: {
  command: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  refuse: LaunchRefusal;
  subject: string;
}): Promise<string> {
  assertSingleExecutableName(input.command, input.platform, input.refuse, input.subject);
  const located = await resolveApplicationCommand(input.command, input.env, input.platform, input.cwd);
  if (located === undefined) {
    throw input.refuse(`the ${safeCommandLabel(input.command)} executable for ${input.subject} was not found; install the CLI or configure an explicit command`);
  }
  return located;
}

interface LauncherHelpers {
  cmdQuote: (arg: string) => string;
  /** Resolves the parent's trusted `SystemRoot\\System32\\cmd.exe`, or null. */
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
}

let cachedLauncherHelperPath: string | undefined;

function isUsableRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Locate the shipped launcher helper module. Both shipped layouts keep scripts/
 * beside the compiled extension, so scripts/ is found by walking upward to the
 * enclosing package root.
 */
function launcherHelperPath(refuse: LaunchRefusal): string {
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
 * No second copy of either rule exists: the launcher is the single authority
 * for both, and requiring the helper per call (Node caches the module) runs
 * exactly what the shipped launcher exports.
 */
export function loadLauncherHelpers(refuse: LaunchRefusal): LauncherHelpers {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const helper = require(launcherHelperPath(refuse)) as Partial<LauncherHelpers>;
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
export const WINDOWS_PERCENT_CARRIER_PREFIX = "PRG_NATIVE_BATCH_PCT_";

/** The carrier's whole value: the single percent sign it exists to deliver. */
const WINDOWS_PERCENT_CARRIER_VALUE = "%";

/**
 * The first unused carrier name in the environment the batch child starts
 * with. Windows environment names are case-insensitive, so an existing variable
 * in any case spelling occupies its slot and is never overwritten or cleared. A
 * finite environment holds finitely many names, so one probe past its size
 * always finds a free slot: preserving a literal argument never costs a valid
 * launch a refusal.
 */
function windowsPercentCarrierName(environment: Readonly<NodeJS.ProcessEnv>, refuse: LaunchRefusal): string {
  const occupied = new Set(Object.keys(environment).map((name) => name.toUpperCase()));
  const slots = occupied.size + 1;
  for (let probe = 0; probe < slots; probe += 1) {
    const name = `${WINDOWS_PERCENT_CARRIER_PREFIX}${probe}`;
    if (!occupied.has(name)) return name;
  }
  // Unreachable: at most `slots - 1` of these `slots` names can already exist.
  throw refuse("no internal Windows batch percent carrier name is free in the configured child environment");
}

/** One rendered Windows batch invocation through the trusted cmd.exe. */
export interface WindowsBatchInvocation {
  /** The parent's trusted `SystemRoot\\System32\\cmd.exe`. */
  file: string;
  /** Always empty: the invocation is delivered only in its verbatim string form. */
  args: string[];
  /** The verbatim `/d /s /v:off /c "…"` remainder after the program path. */
  commandLine: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Render a `.cmd`/`.bat` shim as a batch command through the trusted cmd.exe.
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
 * instead. The shipped launcher's Pi batch path keeps its own `/d /s /c`
 * invocation unchanged.
 *
 * A control character cannot survive a cmd.exe command line (a line break ends
 * the command), so any token carrying one is refused rather than truncated or
 * re-tokenized.
 */
export function renderWindowsBatchInvocation(input: {
  shim: string;
  args: readonly string[];
  parentEnvironment: NodeJS.ProcessEnv;
  childEnvironment: NodeJS.ProcessEnv;
  refuse: LaunchRefusal;
}): WindowsBatchInvocation {
  const { shim, args, parentEnvironment, childEnvironment, refuse } = input;
  if ([shim, ...args].some((token) => typeof token !== "string" || containsControlCharacter(token))) {
    throw refuse("a Windows .cmd/.bat CLI shim cannot receive an argument that is not a printable string");
  }
  const helpers = loadLauncherHelpers(refuse);
  // The parent environment only: the child environment, ComSpec, and PATH stay
  // irrelevant, so a `.cmd`/`.bat` CLI shim never selects its own interpreter.
  const cmdExe = helpers.resolveTrustedWindowsCmd(parentEnvironment);
  if (!cmdExe) {
    throw refuse("a valid regular cmd.exe was not found under the parent process's absolute Windows SystemRoot\\System32, so the configured .cmd/.bat CLI shim cannot be launched");
  }
  // Percent-free batch text stays byte-identical to the delivery before it: no
  // carrier, no clearing, no change to a single quoted token.
  const percentCarrier = [shim, ...args].some((token) => token.includes("%"))
    ? windowsPercentCarrierName(childEnvironment, refuse)
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
  // A PTY's Windows spawn and Node's `windowsVerbatimArguments` spawn both take
  // one pre-escaped command-line string appended verbatim after the program
  // path. cmd.exe needs this whole `/d /s /v:off /c "…"` remainder verbatim,
  // because it does not treat a backslash as an escape: passed as MSDN-escaped
  // argv, the outer quotes would reach cmd.exe as `\"` and the batch command
  // line would be re-tokenized against the operator's own arguments.
  return {
    file: cmdExe,
    args: [],
    commandLine: `/d /s /v:off /c "${carrierClearance}${commandText}"`,
    env,
  };
}

/** One prepared CLI invocation: a direct argv spawn, or a trusted batch command line. */
export type PreparedCliInvocation =
  | { kind: "direct"; file: string; args: string[]; env: NodeJS.ProcessEnv }
  | ({ kind: "windows-batch" } & WindowsBatchInvocation);

/**
 * Render one already-located file and its complete literal argv for the
 * platform. POSIX and a Windows native executable are a direct spawn of the
 * file with the argv and environment unchanged; a Windows `.cmd`/`.bat` file is
 * the trusted batch rendering above.
 */
export function renderCliInvocation(input: {
  file: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  parentEnvironment: NodeJS.ProcessEnv;
  refuse: LaunchRefusal;
}): PreparedCliInvocation {
  if (isWindowsBatchFile(input.file, input.platform)) {
    return {
      kind: "windows-batch",
      ...renderWindowsBatchInvocation({
        shim: input.file,
        args: input.args,
        parentEnvironment: input.parentEnvironment,
        childEnvironment: input.env,
        refuse: input.refuse,
      }),
    };
  }
  return { kind: "direct", file: input.file, args: [...input.args], env: input.env };
}

/** Prefix this process's cwd to a relative directory without lexical normalization. */
function anchorToProcessCwd(directory: string): string {
  const parent = process.cwd();
  const trimmed = sep === "\\" ? parent.replace(/[\\/]+$/u, "") : parent.replace(/\/+$/u, "");
  return trimmed.length === 0 ? `${sep}${directory}` : `${trimmed}${sep}${directory}`;
}

/** The provider CLIs that opt into this preparation. */
export type ProviderCliName = "claude" | "codex";

/**
 * A provider CLI could not be started: the configured command was refused or
 * not found, or the operating system refused to create the process. No
 * provider process exists for such a launch. It is deliberately distinct from
 * a reviewer verdict, a non-zero exit, and an artifact publication failure.
 */
export class CliLaunchError extends Error {
  readonly code = "cli_launch_failed";
  constructor(message: string, readonly provider: ProviderCliName) {
    super(message);
    this.name = "CliLaunchError";
  }
}

/** Whether a value is a {@link CliLaunchError}. */
export function isCliLaunchError(value: unknown): value is CliLaunchError {
  return value instanceof CliLaunchError;
}

/**
 * Prepare one provider CLI child — the spawn a non-PTY caller (the guided
 * reviewer adapters) runs with `shell: false`. Every refusal is a
 * {@link CliLaunchError}.
 *
 * On POSIX the configured command is validated and rendered unchanged: the
 * direct spawn resolves it from the child's cwd and environment with Node's
 * own rules, exactly as a reviewer launch always did, and a missing CLI is the
 * spawn's own refusal (reported as a launch error by `runPromptProcess`). On
 * Windows the command is located first, so a bare name reaches its native
 * PATHEXT executable or trusted batch rendering.
 */
export async function prepareProviderCliSpawn(input: {
  provider: ProviderCliName;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  parentEnvironment?: NodeJS.ProcessEnv;
}): Promise<PreparedCliInvocation> {
  const platform = input.platform ?? process.platform;
  const refuse: LaunchRefusal = (reason) =>
    new CliLaunchError(`pi-review-gate: could not launch the ${input.provider} CLI; ${reason}`, input.provider);
  const subject = `the ${input.provider} CLI`;
  let file = input.command;
  if (platform === "win32") {
    // The child runs in `cwd`, but the located file is spawned by this process.
    // A relative run directory is therefore anchored to this process's cwd —
    // the same directory `spawn(…, { cwd })` changes into — so a relative
    // command or PATH entry yields a path that names the same file from either
    // side. The prefix only concatenates: a `..` after a symlinked directory
    // belongs to that directory's parent, as it does for the spawn. The spawn
    // cwd itself is left exactly as configured.
    const base = isAbsoluteForPlatform(input.cwd, platform) ? input.cwd : anchorToProcessCwd(input.cwd);
    file = await locateCliExecutable({ command: input.command, env: input.env, platform, cwd: base, refuse, subject });
    // cmd.exe cannot run in a UNC directory: under its default configuration it
    // silently substitutes the Windows directory before the shim runs, so the
    // CLI would work — and a reviewer would return a verdict — outside the
    // requested workspace. That launch is refused before anything is spawned;
    // a native executable keeps its UNC run directory.
    if (isWindowsBatchFile(file, platform) && isWindowsUncPath(base)) {
      throw refuse("a Windows .cmd/.bat CLI shim cannot run in a UNC working directory (cmd.exe would substitute the Windows directory); use a mapped drive or a native executable");
    }
  } else {
    assertSingleExecutableName(input.command, platform, refuse, subject);
  }
  return renderCliInvocation({
    file,
    args: input.args,
    env: input.env,
    platform,
    parentEnvironment: input.parentEnvironment ?? process.env,
    refuse,
  });
}
