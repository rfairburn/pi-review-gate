/**
 * #736 slice 3b: per-launch preparation of the BLOCKING native review hook.
 *
 * A hosted native Claude Code row whose review lane is armed gets ONE extra
 * instruction on its own launch: a second, review-only hooks plugin directory,
 * carried by one additional `--plugin-dir` (a repeatable, session-scoped Claude
 * flag), whose `hooks/hooks.json` registers one command handler on `Stop` and one
 * on `UserPromptSubmit`. Both handlers invoke the review relay in
 * ./native-review-hook-relay (`node <relay> <Event>`), which authenticates with
 * the fresh per-owned-launch bootstrap this host issued before the child existed
 * and waits for the host's verdict on that turn.
 *
 * This module prepares exactly that instruction. It never spawns anything, never
 * registers a broker source, never reads provider configuration, trust records,
 * or credentials, and never claims that a hook actually ran.
 *
 * Why the plugin route and never a second `--settings`:
 *
 * Claude merges hook layers additively, but a second `--settings` REPLACES the
 * operator's flag-settings layer. The observer lane already owns the choice
 * between the two routes for its own hooks (./native-hook-launch-prep), and this
 * lane never repeats that decision: `--plugin-dir` is documented as repeatable
 * and session-scoped, existing entries stay exactly as configured, and a plugin's
 * copy of a handler stays separate from any settings copy. So this module ALWAYS
 * stages a plugin directory and NEVER emits `--settings`, whatever the configured
 * argv carries. It still bypasses nothing: the operator's own native policy
 * (`disableSideloadFlags`, marketplace policy, workspace trust, `disableAllHooks`)
 * can withhold the hooks entirely, and an armed lane whose hooks the provider
 * declines to run simply never receives a review request.
 *
 * Command stability is deliberate, and it is what makes the two lanes coexist.
 * The generated handler is the provider's exec form — `command` plus `args` —
 * spawned directly by the provider with no shell, so the Node executable and the
 * compiled relay entry travel as data and no platform quoting rule can distort
 * them (Windows included). The per-launch secret never enters command text or an
 * artifact: it rides only in this family's own child-environment marker
 * (`NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV`), which is a SEPARATE marker from the
 * observer's, so a row with both hooks never shares a secret between an observer
 * and a verdict authority.
 *
 * Artifacts are freshly owned and private: a new `mkdtemp` root under the system
 * temporary directory (never inside a workspace), `0700` directories, `0600`
 * files, exclusive creation, and a cleanup that removes only the exact inodes this
 * call created. An entry it cannot identify as its own is preserved, and no
 * recursive delete or sweep of anything else ever happens. The staging
 * implementation is the observer lane's own namespace class, so the ownership,
 * identity, and cleanup rules are literally one implementation, not two.
 */

import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { NativeArgPositionScan } from "./native-cli-launch";
import { createPeerStatePermissionPolicy } from "./network/peer-state-permissions";
import {
  rejectAndStripInheritedHostCapabilities,
  snapshotNativeEnvironment,
} from "./launch";
import {
  OwnedArtifactNamespace,
  isPrivatePosixArtifactRoot,
  posixQuotedToken,
  tomlBasicString,
  type NativeHookArtifactCleanup,
  type NativeHookArtifactLease,
} from "./native-hook-launch-prep";
import {
  NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV,
  NATIVE_REVIEW_HOOK_EVENTS,
  NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS,
  encodeNativeReviewBootstrapEnv,
  parseNativeReviewBootstrap,
  type NativeReviewBootstrap,
  type NativeReviewHookEventName,
} from "./native-review-hook-protocol";
import { isNativeCliBackend, type NativeCliBackend } from "./session-backend";

/**
 * How long the provider may wait for one review hook attempt, stamped on this
 * lane's own hook handler below. The value is the shared protocol's (both the
 * relay's backstop and the host coordinator's review deadline are derived from
 * it), and it is re-exported here unchanged so every existing importer of this
 * module's launch-side name keeps working.
 */
export { NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS };

/**
 * The one route this lane uses, always. A second `--settings` would replace the
 * operator's flag-settings layer, so it is never emitted here; `--plugin-dir` is
 * repeatable and joins the operator's own entries.
 */
export type NativeReviewHookLaunchRoute =
  /** Claude: one additional review-only `--plugin-dir`. */
  | "claude-plugin-dir"
  /**
   * Owned Codex: `-c hooks.UserPromptSubmit=…` and `-c hooks.Stop=…` on the owned
   * app-server BACKEND render only, invoking this host's stable review shim. The
   * interactive TUI never receives them (a `--remote` TUI ignores its own `-c`
   * hooks; the backend is the core that runs hooks).
   */
  | "codex-owned-backend-config";

/**
 * Closed reasons why the review hook was NOT armed. None of them is a launch
 * failure: the row's interactive launch stays exactly what the provider composed,
 * and the only consequence is that this row has no automatic review.
 */
export type NativeReviewHookUnavailableReason =
  /**
   * This backend has no review-hook route at all. Claude Code and Codex both arm
   * (Codex on its host-owned backend only, under `codex-backend-not-owned`), so
   * this is the defensive answer for any backend beyond the two.
   */
  | "backend-unsupported"
  /** The Node host or the compiled review relay entry this launch would invoke is not usable. */
  | "hook-entry-unavailable"
  /** The bootstrap cannot be carried in the bounded child-environment marker. */
  | "bootstrap-unusable"
  /**
   * This lane's own generated flags would have carried an otherwise valid launch past
   * the shared `MAX_NATIVE_CLI_ARGS` descriptor bound. The lane declines itself so the
   * row keeps the launch it would otherwise have had; a launch already past the bound
   * without this lane is never masked by this reason.
   */
  | "argument-budget"
  /** The private artifact could not be staged (or was staged and then rolled back). */
  | "artifact-staging-failed"
  /**
   * Codex without the host-owned app-server backend. Only that backend's hooks can
   * be given to the provider without touching the operator's interactive client,
   * so a non-owned Codex launch gets no review lane.
   */
  | "codex-backend-not-owned"
  /**
   * The operator's own `-c`/`--config` already writes the whole Codex `hooks`
   * table, or `hooks.Stop` / `hooks.UserPromptSubmit` (either spelling). A
   * later host override would silently replace or be replaced by it, so this lane
   * declines instead of composing over the operator's configuration.
   */
  | "operator-hook-override"
  /**
   * The observer lane explicitly declined this launch. The manager retires the
   * status run — and with it this row's review registration — before spawning, so
   * a blocking review hook would have no live lane to answer it. Nothing is staged.
   */
  | "observer-unavailable";

/**
 * The caller's handle on the artifacts this preparation staged. Same ownership
 * rule as the observer lane's lease: the manager releases it only after this row's
 * own settlement, cleanup is idempotent, and it reports exactly what it removed
 * and what it refused to touch.
 */
export type NativeReviewHookArtifactLease = NativeHookArtifactLease;

export type { NativeHookArtifactCleanup as NativeReviewHookArtifactCleanup };

/** Review hook armed for this launch; the flags and marker are in the descriptor. */
export interface NativeReviewHookLaunchPrepared {
  readonly review: "prepared";
  readonly backend: NativeCliBackend;
  readonly route: NativeReviewHookLaunchRoute;
  /**
   * The generated provider flags, in the order they were composed. They carry no
   * secret: the token travels only in `environment`. Exactly one additional
   * `--plugin-dir` and never a `--settings`.
   */
  readonly args: readonly string[];
  /** The single fresh child-environment entry, keyed by this family's own marker name. */
  readonly environment: Readonly<Record<string, string>>;
  readonly lease: NativeReviewHookArtifactLease;
}

/** Review hook deliberately not armed; the launch proceeds unchanged. */
export interface NativeReviewHookLaunchUnavailable {
  readonly review: "unavailable";
  readonly backend: NativeCliBackend;
  readonly reason: NativeReviewHookUnavailableReason;
}

export type NativeReviewHookLaunchOutcome =
  | NativeReviewHookLaunchPrepared
  | NativeReviewHookLaunchUnavailable;

/** Absolute existing files the generated hook handler invokes. */
export interface NativeReviewHookEntrypoints {
  readonly nodeExecutable: string;
  readonly relayEntry: string;
}

/** Input for one preparation. The caller owns every field; none is mutated. */
export interface NativeReviewHookLaunchPreparationInput {
  readonly backend: NativeCliBackend;
  /** Fresh bootstrap issued by the broker's native review registration for this launch. */
  readonly bootstrap: NativeReviewBootstrap;
  readonly platform: NodeJS.Platform;
  /**
   * The environment this launch will hand the child. Only read, never mutated: a
   * genuine worker-role authorization in it is rejected before any artifact exists.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Test seam for literal-path coverage only: production passes nothing. Both
   * values still have to be absolute printable regular files.
   */
  readonly entrypoints?: NativeReviewHookEntrypoints;
  /** Codex only: true when this launch runs the host-owned app-server backend. */
  readonly ownedCodexBackend?: boolean;
  /** Codex only: the launcher's ONE option scan of the configured argv (conflict check). */
  readonly scan?: NativeArgPositionScan;
  /**
   * Codex only: the host's stable, private review-hook directory (inside this
   * host's own state directory). The shim lives at a fixed name in it, so the hook
   * definition Codex is asked to trust never changes between launches.
   */
  readonly codexHookDirectory?: string;
  /** Windows only: the shipped launcher's single `cmdQuote` authority. */
  readonly windowsCommandQuoter?: (token: string) => string;
}

/** The stable shim's file name inside {@link NativeReviewHookLaunchPreparationInput.codexHookDirectory}. */
export const CODEX_REVIEW_SHIM_NAME = "codex-review-hook";

/** The shim path for one platform: a `.cmd` batch file on Windows, an `sh` script elsewhere. */
export function codexReviewShimPath(directory: string, platform: NodeJS.Platform): string {
  return join(directory, platform === "win32" ? `${CODEX_REVIEW_SHIM_NAME}.cmd` : CODEX_REVIEW_SHIM_NAME);
}

/**
 * The shim's exact contents. It is the ONLY place the Node executable and the
 * compiled relay entry are named, so upgrading either rewrites this file while the
 * hook definition Codex trusted (which names only the shim) stays byte for byte the
 * same. Returns null when a path cannot be carried literally.
 */
export function codexReviewShimContents(
  entrypoints: NativeReviewHookEntrypoints,
  platform: NodeJS.Platform,
  windowsCommandQuoter?: (token: string) => string,
): string | null {
  const tokens = [entrypoints.nodeExecutable, entrypoints.relayEntry];
  if (tokens.some((token) => containsControlCharacter(token))) return null;
  if (platform !== "win32") {
    return `#!/bin/sh\nexec ${tokens.map((token) => posixQuotedToken(token)).join(" ")} "$@"\n`;
  }
  // A batch file expands `%` everywhere and `!` under delayed expansion, so a path
  // carrying either cannot be named literally; the lane declines instead.
  if (tokens.some((token) => /[%!]/u.test(token))) return null;
  if (typeof windowsCommandQuoter !== "function") return null;
  return `@echo off\r\n${tokens.map((token) => windowsCommandQuoter(token)).join(" ")} %*\r\n`;
}

/**
 * The two `-c` values this lane adds to the owned backend, in a fixed order. The
 * handler names only the stable shim and the event, with a fixed timeout, so
 * Codex's trust hash (event + matcher + normalized handler) is identical on every
 * launch and the one-time `/hooks` trust stays valid across workspaces.
 */
export function codexReviewHookConfigArgs(
  shimPath: string,
  platform: NodeJS.Platform,
  windowsCommandQuoter?: (token: string) => string,
): string[] | null {
  if (containsControlCharacter(shimPath)) return null;
  if (platform === "win32" && (/[%!]/u.test(shimPath) || typeof windowsCommandQuoter !== "function")) return null;
  const args: string[] = [];
  for (const event of CODEX_REVIEW_HOOK_EVENT_ORDER) {
    const handler = [
      "type=\"command\"",
      `command=${tomlBasicString(`${posixQuotedToken(shimPath)} ${event}`)}`,
      ...(platform === "win32" && windowsCommandQuoter !== undefined
        ? [`commandWindows=${tomlBasicString(`${windowsCommandQuoter(shimPath)} ${event}`)}`]
        : []),
      `timeout=${NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS}`,
    ].join(",");
    args.push("-c", `hooks.${event}=[{hooks=[{${handler}}]}]`);
  }
  return args;
}

/** Fixed emission order of the two Codex review events. */
const CODEX_REVIEW_HOOK_EVENT_ORDER: readonly NativeReviewHookEventName[] = Object.freeze(
  ["UserPromptSubmit", "Stop"] as NativeReviewHookEventName[],
);

/**
 * True when the operator's own configuration already writes a Codex hook path this
 * lane would add, or the whole `hooks` table. Codex splits an override at the first
 * `=`, trims, and walks the key on `.`; the same reading decides what collides. A
 * quoted key segment is unquoted first, and a segment this reading cannot classify
 * is treated as a collision — declining is the safe answer.
 */
export function codexReviewHookOverrideConflict(scan: NativeArgPositionScan): boolean {
  return scan.options.some((option) => {
    if (option.name !== "-c" && option.name !== "--config") return false;
    const assignment = option.attached ?? option.operand;
    if (typeof assignment !== "string") return true;
    const segments = assignment.split("=")[0].split(".").map((segment) => {
      const trimmed = segment.trim();
      return /^"[^"]*"$|^'[^']*'$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
    });
    if (segments[0] !== "hooks") return false;
    if (segments.length === 1) return true;
    return ["Stop", "stop", "UserPromptSubmit", "user_prompt_submit"].includes(segments[1] ?? "");
  });
}

/** A refusal for a request that violates this module's contract. */
function refuse(reason: string): Error {
  return new Error(`pi-review-gate: refusing to prepare the native review hook; ${reason}`);
}

/** The same printable-text rule the launch adapter applies to argv and env. */
function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function unavailable(
  backend: NativeCliBackend,
  reason: NativeReviewHookUnavailableReason,
): NativeReviewHookLaunchUnavailable {
  return { review: "unavailable", backend, reason };
}

/**
 * The compiled review relay entry sits beside this module in every shipped and
 * test layout, so its own directory is the only place it is looked for.
 */
function defaultRelayEntry(): string {
  return join(__dirname, "native-review-hook-relay.js");
}

function isUsableRegularFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The two absolute files the generated handler names. A missing entry is a broken
 * installation, not an operator error: the operator's launch stays exactly as
 * configured and this row simply has no automatic review.
 */
export function resolveNativeReviewHookEntrypoints(
  entrypoints: NativeReviewHookEntrypoints | undefined,
): NativeReviewHookEntrypoints | null {
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
 * The exact hooks document this lane stages, in Claude's own plugin schema: the
 * event map inside a top-level `hooks` key (a bare event map would fail to load),
 * one matcher group per event, one handler per group.
 *
 * No `matcher` (this lane answers every root turn of these two events), and no
 * `onFailure`: the provider's own default is the correct reading of a hook child
 * that never answered, and this module adds no policy the provider does not
 * already have.
 */
export function nativeReviewHookEventMap(
  entrypoints: NativeReviewHookEntrypoints,
): Readonly<Record<string, readonly unknown[]>> {
  const map: Record<string, readonly unknown[]> = {};
  for (const event of NATIVE_REVIEW_HOOK_EVENTS) {
    const handler = {
      type: "command",
      command: entrypoints.nodeExecutable,
      // The relay takes the provider event name as argv and cross-checks it
      // against the provider's own stdin document; a disagreement is a closed
      // failure there, never a guess.
      args: [entrypoints.relayEntry, event as NativeReviewHookEventName],
      timeout: NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS,
    };
    map[event] = [{ hooks: [handler] }];
  }
  return map;
}

/** The plugin manifest: a stable name, and nothing but hooks in the plugin. */
function nativeReviewPluginManifest(): string {
  return `${JSON.stringify({
    name: "pi-review-gate-native-review",
    version: "1.0.0",
    description: "pi-review-gate blocking native turn-review hooks (no commands, agents, skills, or MCP servers)",
  })}\n`;
}

/** The plugin directory's own name inside this preparation's private root. */
const PLUGIN_DIR_NAME = "claude-review-plugin";

/** Stage the review-only plugin and report the flag that points at it. */
function stageReviewPluginArtifacts(
  namespace: OwnedArtifactNamespace,
  entrypoints: NativeReviewHookEntrypoints,
): string[] {
  const pluginRoot = namespace.makeDirectory(PLUGIN_DIR_NAME);
  namespace.makeDirectory(`${PLUGIN_DIR_NAME}/.claude-plugin`);
  namespace.makeDirectory(`${PLUGIN_DIR_NAME}/hooks`);
  namespace.writeFile(`${PLUGIN_DIR_NAME}/.claude-plugin/plugin.json`, nativeReviewPluginManifest());
  namespace.writeFile(
    `${PLUGIN_DIR_NAME}/hooks/hooks.json`,
    `${JSON.stringify({ hooks: nativeReviewHookEventMap(entrypoints) })}\n`,
  );
  return ["--plugin-dir", pluginRoot];
}

/**
 * Prepare one launch's native review hook.
 *
 * Contract, in order:
 *
 * 1. A backend this build does not arm a review hook for is an `unavailable`
 *    outcome, never a partial arming and never a refusal.
 * 2. The bootstrap is re-validated strictly and its backend must be the requested
 *    backend; a foreign, half-built, or cross-backend bootstrap is a refusal.
 * 3. A genuine worker-role authorization in the launch environment is rejected
 *    BEFORE any filesystem effect. The caller's environment object is never
 *    mutated, and no other value is read out of it.
 * 4. Artifacts are staged last, in a freshly owned private root, and a failure
 *    partway through rolls back exactly what this call created.
 */
export async function prepareNativeReviewHookLaunch(
  input: NativeReviewHookLaunchPreparationInput,
): Promise<NativeReviewHookLaunchOutcome> {
  const { backend, platform } = input;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") {
    throw refuse(`the native review hook is prepared for macOS/Linux and Windows descriptors only; ${platform} is unsupported`);
  }
  if (!isNativeCliBackend(backend)) {
    throw refuse(`"${String(backend)}" is not a native interactive CLI backend`);
  }
  if (backend === "codex") {
    // Only the host-owned app-server backend runs hooks this host may configure
    // without touching the operator's interactive client; anything else declines
    // before reading the bootstrap or staging anything.
    if (input.ownedCodexBackend !== true) return unavailable(backend, "codex-backend-not-owned");
    if (input.scan === undefined) throw refuse("an owned Codex review preparation requires the launcher's option scan");
    if (codexReviewHookOverrideConflict(input.scan)) return unavailable(backend, "operator-hook-override");
  } else if (backend !== "claude") {
    return unavailable(backend, "backend-unsupported");
  }
  const bootstrap = parseNativeReviewBootstrap(input.bootstrap);
  if (bootstrap === undefined) {
    throw refuse("the native review bootstrap is missing, malformed, or carries an unexpected field");
  }
  if (bootstrap.backend !== backend) {
    throw refuse(`the native review bootstrap is registered for ${bootstrap.backend} and cannot arm a ${backend} launch`);
  }

  // Fail closed on worker authorization before any artifact exists. This is the
  // same provider-neutral rule the launch adapter applies, so a direct caller of
  // this module cannot stage files either.
  const roleProbe = snapshotNativeEnvironment(input.env ?? {}, platform);
  rejectAndStripInheritedHostCapabilities(roleProbe);

  let encodedBootstrap: string;
  try {
    encodedBootstrap = encodeNativeReviewBootstrapEnv(bootstrap);
  } catch {
    return unavailable(backend, "bootstrap-unusable");
  }

  const entrypoints = resolveNativeReviewHookEntrypoints(input.entrypoints);
  if (entrypoints === null) return unavailable(backend, "hook-entry-unavailable");

  // The fresh marker is this family's own single entry; the secret never enters
  // provider command text or an artifact.
  const environment: Readonly<Record<string, string>> = {
    [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: encodedBootstrap,
  };

  if (backend === "codex") {
    return prepareCodexReviewHook(input, entrypoints, environment);
  }

  let namespace: OwnedArtifactNamespace | undefined;
  try {
    // This lane's root is EXECUTABLE CONFIGURATION for the launched provider, so it
    // opts in to a proven private root on every platform. The observer lane keeps its own
    // existing staging behavior untouched. A refusal here throws before any plugin
    // file exists, and the catch below answers `unavailable`.
    namespace = OwnedArtifactNamespace.create("prg-native-review-", true);
    const args = stageReviewPluginArtifacts(namespace, entrypoints);
    const staged = namespace;
    return {
      review: "prepared",
      backend,
      route: "claude-plugin-dir",
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

/** Codex's stable shim needs no per-launch artifact, so its lease removes nothing. */
const STABLE_SHIM_LEASE: NativeReviewHookArtifactLease = Object.freeze({
  root: null,
  cleanup: async (): Promise<NativeHookArtifactCleanup> => ({ removed: [], preserved: [] }),
});

/**
 * The owned Codex half of {@link prepareNativeReviewHookLaunch}: prove the host's
 * stable hook directory private, (re)write the shim only when its contents differ,
 * and hand back the two backend-only `-c` values plus this launch's marker. The
 * marker is the only per-launch value, and it travels in the backend child's
 * environment, never in the hook definition Codex hashes for trust.
 */
function prepareCodexReviewHook(
  input: NativeReviewHookLaunchPreparationInput,
  entrypoints: NativeReviewHookEntrypoints,
  environment: Readonly<Record<string, string>>,
): NativeReviewHookLaunchOutcome {
  const { backend, platform } = input;
  const directory = input.codexHookDirectory;
  if (typeof directory !== "string" || directory.length === 0 || !isAbsolute(directory)
    || containsControlCharacter(directory)) {
    return unavailable(backend, "artifact-staging-failed");
  }
  const shimPath = codexReviewShimPath(directory, platform);
  const contents = codexReviewShimContents(entrypoints, platform, input.windowsCommandQuoter);
  const args = codexReviewHookConfigArgs(shimPath, platform, input.windowsCommandQuoter);
  if (contents === null || args === null) return unavailable(backend, "hook-entry-unavailable");
  try {
    writeStableShim(directory, shimPath, contents, platform);
  } catch {
    return unavailable(backend, "artifact-staging-failed");
  }
  return {
    review: "prepared",
    backend,
    route: "codex-owned-backend-config",
    args,
    environment,
    lease: STABLE_SHIM_LEASE,
  };
}

/**
 * Prove the shim directory private, then leave an identical shim untouched or
 * replace it atomically. The directory is executable configuration for every
 * Codex row of this host: the trusted hook names this path, so whoever can write
 * here could run code as the user. It is therefore re-proven on every launch
 * (POSIX: the same no-follow ancestry walk and extended-ACL proof as the review
 * plugin root; Windows: the host's private-DACL policy), and a shim that is not a
 * regular file owned by this account is never reused.
 */
function writeStableShim(directory: string, shimPath: string, contents: string, platform: NodeJS.Platform): void {
  if (platform === "win32") {
    createPeerStatePermissionPolicy().assertPrivateDirectory(directory);
  } else if (!isPrivatePosixArtifactRoot(directory)) {
    throw new Error("the native review hook directory is not private");
  }
  if (dirname(shimPath) !== directory) throw new Error("the native review shim must sit directly in its directory");
  if (existingShimMatches(shimPath, contents, platform)) return;
  const temporary = join(directory, `.${CODEX_REVIEW_SHIM_NAME}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    // Exclusive creation: a name that already exists is never followed or reused.
    descriptor = openSync(temporary, "wx", 0o700);
    writeSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = undefined;
    if (platform !== "win32") chmodSync(temporary, 0o700);
    renameSync(temporary, shimPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Already closed or never usable; the removal below still runs.
      }
    }
    rmSync(temporary, { force: true });
    throw error;
  }
}

function existingShimMatches(shimPath: string, contents: string, platform: NodeJS.Platform): boolean {
  try {
    const stats = lstatSync(shimPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    if (platform !== "win32") {
      const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
      if (uid === undefined || stats.uid !== uid || (stats.mode & 0o7777) !== 0o700) return false;
    }
    return readFileSync(shimPath, "utf8") === contents;
  } catch {
    return false;
  }
}
