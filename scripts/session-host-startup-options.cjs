#!/usr/bin/env node
"use strict";

/**
 * Shared admission check for parent startup session overrides (issue 323).
 *
 * The session host spawns one NEW native Pi chat per instance: each gets its
 * own ID, default-profile-owned storage, and the chosen workspace. Parent
 * startup options that select, continue, resume, fork, or disable session
 * persistence — or that redirect session storage — would be inherited by
 * EVERY created instance (native Pi would open the same old chat, cwd, or
 * storage), breaking that pairing. This helper rejects exactly those
 * overrides:
 *
 *   --continue/-c, --resume/-r, --session[=value], --session-id[=value],
 *   --fork[=value], --session-dir[=value], --no-session
 *   and a nonempty inherited PI_CODING_AGENT_SESSION_DIR.
 *
 * It also declines Pi 1.7.0's `--agent-dir <dir>` profile override, which would
 * repoint every hosted native Pi row to another agent directory (see
 * AGENT_DIR_FLAG below). PI_CODING_AGENT_DIR stays the supported host-wide
 * selection and is never rejected here.
 *
 * It is pure and side-effect free (no fs, no process/env mutation, no PTY or
 * setup), so the launcher runs it in preflight BEFORE any build/DDGS/profile/
 * token work and prepareNativeLaunch runs it again defensively before any
 * filesystem mutation. Diagnostics are bounded to the fixed override name:
 * never a value, path, transcript, or environment content.
 *
 * Native grammar (Pi 1.0.4 and 1.1.0 dist/cli/args.js): after Pi's OWN
 * literal `--` the remaining tokens are message/file data, never options.
 * Known value-taking flags consume the next token even when it looks like an
 * option (`--model --session`: the second token is value DATA and must not be
 * rejected). Only the EXACT flag token consumes its value; a `--flag=value`
 * spelling of a known flag is an unknown extension flag and consumes nothing.
 * The bounded explicit sets and conditional consumers below mirror the
 * supported parser and are shared by admission and fresh-session composition.
 *
 * prepareNativeLaunch consumes every exact `--scheduler` token (the wrapper
 * opt-in contract), which shifts native option boundaries (e.g.
 * `--system-prompt --scheduler -- --session …` becomes
 * `--system-prompt -- --session …`, where `--session` IS an option). The scan
 * therefore runs on the effective sequence with exact `--scheduler` tokens
 * removed, as a nonmutating view of the caller's array.
 *
 * Pi 1.7.0 adds a second, EARLIER profile selector: `--agent-dir <dir>`
 * (packages/coding-agent/src/cli/agent-dir-arg.ts) is applied by a raw
 * exact-token scan of the argument vector that runs before and independently of
 * the normal option parser, so a known value-taking flag never shields it
 * (`--model --agent-dir B` still selects B). That scan stops at the first
 * literal `--`, and Pi 1.7.0 recognizes no `--agent-dir=value` spelling. The
 * session host pins ONE canonical agent directory for every native Pi row, so
 * an effective hosted `--agent-dir` is declined the same way: by a raw scan of
 * the same effective sequence that stops on the first literal `--`, never by
 * the value-consuming group walk.
 */

/** Blocked long option names (exact name, or the same name with an attached `=value`). */
const BLOCKED_LONG_OPTIONS = new Set([
  "continue",
  "resume",
  "session",
  "session-id",
  "fork",
  "session-dir",
  "no-session",
]);

/** Blocked short option names (exact token only; Pi has no `=` spelling for shorts). */
const BLOCKED_SHORT_OPTIONS = new Set(["c", "r"]);

/**
 * Pi 1.7.0's command-line form of PI_CODING_AGENT_DIR: the exact split token
 * `--agent-dir <dir>`. It is declined rather than blocked-listed, because the
 * blocked list also matches attached `--name=value` spellings and Pi 1.7.0 does
 * NOT treat `--agent-dir=value` as a profile selection — that spelling stays
 * ordinary unknown-extension-flag data. The session host pins one canonical
 * agent directory for every native Pi row (the sidebar roster, the exclusive
 * host ownership record, the Saved conversations catalog, and the managed Pi
 * runtime cache all resolve there, and every child descriptor re-pins it), so a
 * hosted child that repointed its profile would split that one ownership domain
 * across two profiles. `PI_CODING_AGENT_DIR` remains the supported host-wide
 * selection, standalone `pi --agent-dir` is unaffected, and the refusal never
 * echoes the named directory.
 */
const AGENT_DIR_FLAG = "--agent-dir";

/**
 * Native long flags that never consume a following token. Pi leaves the next
 * non-option token as a positional message, so fresh-session composition must
 * drop it rather than mistaking it for an optional extension-flag value.
 * Keep this explicit set in sync with the supported Pi parser.
 */
const NATIVE_VALUELESS_OPTIONS = new Set([
  "help",
  "version",
  "no-session",
  "no-tools",
  "no-builtin-tools",
  "no-extensions",
  "no-mcp",
  "no-skills",
  "no-prompt-templates",
  "no-context-files",
  "no-themes",
  "offline",
  "approve",
  "no-approve",
  "verbose",
]);

/**
 * Native flags that consume the NEXT token as their value unconditionally
 * (even when it looks like an option or a file), so a blocked name in that
 * position is value data, not an option. Bounded explicit list from Pi 1.0.4
 * dist/cli/args.js; keep in sync with the supported release. The blocked
 * value options (--session, --session-id, --fork, --session-dir) are not
 * listed: they reject before any consumption matters.
 */
const NATIVE_VALUE_OPTIONS = new Set([
  "provider",
  "model",
  "api-key",
  "system-prompt",
  "append-system-prompt",
  "name",
  "models",
  "tools",
  "exclude-tools",
  "thinking",
  "export",
  "extension",
  "skill",
  "prompt-template",
  "theme",
]);

/** Short spellings of the unconditional value options above. */
const NATIVE_SHORT_VALUE_OPTIONS = new Set(["n", "t", "xt", "e"]);

/** Conditional-value consumers copied from Pi's supported parseArgs grammar. */
const NATIVE_CONDITIONAL_VALUE_OPTIONS = new Set(["mode", "use-theme", "list-models", "print", "tui-mode"]);

/** Pi config env (dist/config.js ENV_SESSION_DIR): redirects all session storage. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const WINDOWS_ROLE_ENV_NAMES = new Set([
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
]);
const WINDOWS_HOST_ONLY_ENV_NAMES = new Set([
  "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP",
  "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE",
  "PI_REVIEW_GATE_SESSION_HOST_STARTUP_REQUEST",
  "PI_REVIEW_GATE_SESSION_HOST_TITLE_COLUMNS",
  "PI_REVIEW_GATE_DDGS_PYTHON",
  ...["SECRET", "PATH", "SESSION", "CHILD"].flatMap((suffix) => [
    `PI_REVIEW_GATE_SETTLEMENT_${suffix}`,
    `PI_REVIEW_GATE_QUIESCENCE_${suffix}`,
  ]),
]);

class SessionHostStartupOptionError extends Error {}

function assertNativeArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new SessionHostStartupOptionError("Invalid session host startup arguments.");
  }
}

/**
 * The argument sequence Pi would actually parse: the wrapper consumes every
 * exact `--scheduler` token, which shifts native option boundaries. Returned as
 * a fresh array so no caller's array is ever mutated.
 */
function effectiveNativeArgs(args) {
  assertNativeArgs(args);
  return args.filter((arg) => arg !== "--scheduler");
}

/**
 * True when Pi 1.7.0's early profile scan would repoint the launch to another
 * agent directory: the exact `--agent-dir` token appears anywhere before the
 * first literal `--`. Deliberately independent of the value-consuming group
 * walk, so a preceding value-taking flag cannot hide it.
 */
function selectsEarlyAgentDir(args) {
  for (const token of effectiveNativeArgs(args)) {
    if (token === "--") return false;
    if (token === AGENT_DIR_FLAG) return true;
  }
  return false;
}

function conditionalValueKind(name, next) {
  if (next === undefined) return undefined;
  if (name === "mode" || name === "use-theme") return next.startsWith("-") ? undefined : "value";
  if (name === "list-models") return next.startsWith("-") || next.startsWith("@") ? undefined : "value";
  if (name === "print") {
    return !next.startsWith("@") && (!next.startsWith("-") || next.startsWith("---")) ? "message" : undefined;
  }
  if (name === "tui-mode") return next.startsWith("-") ? undefined : "value";
  return undefined;
}

/**
 * Parse only the token-consumption behavior needed by host admission and
 * per-child fresh-session argument composition. Every returned group retains
 * the caller's original option/value token bytes.
 */
function nativeArgumentGroups(args) {
  const nativeArgs = effectiveNativeArgs(args);
  const groups = [];
  for (let index = 0; index < nativeArgs.length; index += 1) {
    const token = nativeArgs[index];
    if (token === "--") break;

    let name;
    let shortName;
    let attachedValue = false;
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      name = (eqIndex === -1 ? token : token.slice(0, eqIndex)).slice(2);
      attachedValue = eqIndex !== -1;
    } else if (token.startsWith("-")) {
      shortName = token.slice(1);
      name = ({ n: "name", t: "tools", xt: "exclude-tools", e: "extension", p: "print", c: "continue", r: "resume" })[shortName]
        || shortName;
    }

    if (name === undefined) {
      groups.push({ kind: "message", tokens: [token] });
      continue;
    }

    const next = nativeArgs[index + 1];
    let valueKind;
    if (!attachedValue) {
      if (token.startsWith("--") && NATIVE_VALUE_OPTIONS.has(name) && next !== undefined) {
        valueKind = "value";
      } else if (shortName !== undefined && NATIVE_SHORT_VALUE_OPTIONS.has(shortName) && next !== undefined) {
        valueKind = "value";
      } else if (token.startsWith("--") && NATIVE_CONDITIONAL_VALUE_OPTIONS.has(name)) {
        valueKind = conditionalValueKind(name, next);
      } else if (shortName === "p") {
        valueKind = conditionalValueKind("print", next);
      } else if (token.startsWith("--") && !NATIVE_VALUE_OPTIONS.has(name)
        && !NATIVE_VALUELESS_OPTIONS.has(name)
        && !NATIVE_CONDITIONAL_VALUE_OPTIONS.has(name)
        && next !== undefined && !next.startsWith("-") && !next.startsWith("@")) {
        // Extension-registered long options consume their optional value only
        // when it is neither another option nor an @file argument.
        valueKind = "value";
      }
    }

    const tokens = [token];
    if (valueKind === "value") {
      tokens.push(next);
      index += 1;
    }
    groups.push({
      kind: "option",
      name,
      shortName,
      attachedValue,
      tokens,
      valueKind,
    });
    if (valueKind === "message") {
      groups.push({ kind: "message", tokens: [next] });
      index += 1;
    }
  }
  return groups;
}

/**
 * Compose only the options for a new sibling session. Parent messages and
 * file arguments (including the host's `-p` message and everything after
 * Pi's `--`) are deliberately not inherited. The actual initial request is
 * delivered by the child reporter's public sendUserMessage API, avoiding
 * Pi's @file expansion for `@`-leading prompt text.
 *
 * This also keeps the profile selector honest. Composition normally drops
 * everything after Pi's `--`, so a post-delimiter `--agent-dir` is not inherited
 * — but that stop is only reached when the parser meets `--` as a delimiter. A
 * value-taking option can consume it instead (`--name -- --agent-dir <dir>`
 * makes `--` the old title), and composition then drops that whole `--name` pair,
 * so the surviving `--agent-dir <dir>` tokens land in the child's raw early
 * option area where Pi's profile scan would honor them. This function therefore
 * does not try to re-derive the parent's delimiter; the shared admission above,
 * which prepareNativeLaunch runs again on the composed child arguments, is what
 * makes such a reconstructed override fail closed instead of launching a child on
 * a second profile.
 */
function composeFreshSessionSpawnArgs(args, title) {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new SessionHostStartupOptionError("Invalid session name for fresh native launch.");
  }
  const kept = [];
  for (const group of nativeArgumentGroups(args)) {
    if (group.kind !== "option" || (group.name === "name" && !group.attachedValue)) continue;
    kept.push(...group.tokens);
  }
  return [...kept, "--name", title];
}

/**
 * Detach an environment snapshot using Windows' case-insensitive name rules.
 * Role/catalog authorization is retained for fail-closed rejection; only
 * stale host-owned capabilities are discarded. Conflicting ordinary aliases
 * are ambiguous and reject rather than choosing whichever a child sees.
 */
function snapshotSessionHostEnvironment(env, platform = process.platform) {
  if (env === undefined) return {};
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    throw new SessionHostStartupOptionError("Invalid session host environment.");
  }
  if (platform !== "win32") return { ...env };

  const valuesByName = new Map();
  for (const [rawName, value] of Object.entries(env)) {
    const name = rawName.toUpperCase();
    if (WINDOWS_HOST_ONLY_ENV_NAMES.has(name)) continue;
    const values = valuesByName.get(name) || [];
    values.push(value);
    valuesByName.set(name, values);
  }

  const snapshot = {};
  for (const [name, values] of valuesByName) {
    if (WINDOWS_ROLE_ENV_NAMES.has(name)) {
      // A benign empty spelling must never shadow a nonempty worker marker.
      snapshot[name] = values.find((value) => typeof value === "string" && value.length > 0) ?? values[0];
      continue;
    }
    const [value, ...aliases] = values;
    if (aliases.some((alias) => alias !== value)) {
      throw new SessionHostStartupOptionError(
        "Conflicting case variants in the Windows environment; refusing to select one value.",
      );
    }
    snapshot[name] = value;
  }
  return snapshot;
}

/**
 * Assert that the native args and environment carry no parent startup session
 * or agent-directory override. Throws SessionHostStartupOptionError with a
 * bounded, secret-safe diagnostic (the fixed override name only) on the first
 * violation; returns undefined when admitted. Never mutates its inputs.
 *
 * @param {readonly string[]} args Native Pi arguments (after the wrapper's own `--`).
 * @param {NodeJS.ProcessEnv} [env] Environment to check for a session-dir override.
 */
function assertSessionHostStartupOptions(args, env, platform = process.platform) {
  // Pi applies its own profile scan before parsing anything else, so this check
  // runs first and mirrors that raw, value-consumption-independent scan.
  if (selectsEarlyAgentDir(args)) {
    throw new SessionHostStartupOptionError(
      "session host startup override is not accepted: --agent-dir (the session host pins one shared agent directory for every native Pi session; PI_CODING_AGENT_DIR is the supported host-wide profile override)",
    );
  }

  for (const group of nativeArgumentGroups(args)) {
    if (group.kind !== "option") continue;
    if (group.shortName !== undefined && BLOCKED_SHORT_OPTIONS.has(group.shortName)) {
      throw new SessionHostStartupOptionError(`session host startup override is not accepted: -${group.shortName}`);
    }
    if (group.shortName === undefined && BLOCKED_LONG_OPTIONS.has(group.name)) {
      throw new SessionHostStartupOptionError(`session host startup override is not accepted: --${group.name}`);
    }
  }

  const snapshot = env === undefined ? undefined : snapshotSessionHostEnvironment(env, platform);
  const sessionDir = snapshot === undefined ? undefined : snapshot[SESSION_DIR_ENV];
  if (typeof sessionDir === "string" && sessionDir.length > 0) {
    throw new SessionHostStartupOptionError(`session host startup override is not accepted: ${SESSION_DIR_ENV}`);
  }
}

module.exports = {
  assertSessionHostStartupOptions,
  composeFreshSessionSpawnArgs,
  snapshotSessionHostEnvironment,
  SessionHostStartupOptionError,
  SESSION_DIR_ENV,
};
