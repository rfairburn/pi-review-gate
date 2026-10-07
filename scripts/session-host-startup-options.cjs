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
 * It is pure and side-effect free (no fs, no process/env mutation, no PTY or
 * setup), so the launcher runs it in preflight BEFORE any build/DDGS/profile/
 * token work and prepareNativeLaunch runs it again defensively before any
 * filesystem mutation. Diagnostics are bounded to the fixed override name:
 * never a value, path, transcript, or environment content.
 *
 * Native grammar (Pi 1.0.4 dist/cli/args.js): after Pi's OWN literal `--`
 * the remaining tokens are message/file data, never options. Known
 * value-taking flags consume the next token even when it looks like an
 * option (`--model --session`: the second token is value DATA and must not
 * be rejected). Only the EXACT flag token consumes its value; a `--flag=value`
 * spelling of a known flag is an unknown extension flag in Pi 1.0.4 and
 * consumes nothing. The bounded explicit sets below mirror that parser; there
 * is deliberately no general option parser here.
 *
 * prepareNativeLaunch consumes every exact `--scheduler` token (the wrapper
 * opt-in contract), which shifts native option boundaries (e.g.
 * `--system-prompt --scheduler -- --session …` becomes
 * `--system-prompt -- --session …`, where `--session` IS an option). The scan
 * therefore runs on the effective sequence with exact `--scheduler` tokens
 * removed, as a nonmutating view of the caller's array.
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

/** Pi config env (dist/config.js ENV_SESSION_DIR): redirects all session storage. */
const SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";

class SessionHostStartupOptionError extends Error {}

/**
 * Assert that the native args and environment carry no parent startup
 * session override. Throws SessionHostStartupOptionError with a bounded,
 * secret-safe diagnostic (the fixed override name only) on the first
 * violation; returns undefined when admitted. Never mutates its inputs.
 *
 * @param {readonly string[]} args Native Pi arguments (after the wrapper's own `--`).
 * @param {NodeJS.ProcessEnv} [env] Environment to check for a session-dir override.
 */
function assertSessionHostStartupOptions(args, env) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new SessionHostStartupOptionError("Invalid session host startup arguments.");
  }

  // Effective native sequence after the wrapper's --scheduler removal
  // (nonmutating view; see module doc).
  const nativeArgs = args.filter((arg) => arg !== "--scheduler");

  for (let index = 0; index < nativeArgs.length; index += 1) {
    const token = nativeArgs[index];
    if (token === "--") break; // Pi's own separator: everything after is message/file data
    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      const name = (eqIndex === -1 ? token : token.slice(0, eqIndex)).slice(2);
      if (BLOCKED_LONG_OPTIONS.has(name)) {
        throw new SessionHostStartupOptionError(`session host startup override is not accepted: --${name}`);
      }
      // Only the exact flag token consumes its value; `--flag=value` is an
      // unknown extension flag in Pi 1.0.4 and consumes nothing.
      if (eqIndex === -1 && NATIVE_VALUE_OPTIONS.has(name) && index + 1 < args.length) index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      const name = token.slice(1);
      if (BLOCKED_SHORT_OPTIONS.has(name)) {
        throw new SessionHostStartupOptionError(`session host startup override is not accepted: -${name}`);
      }
      if (NATIVE_SHORT_VALUE_OPTIONS.has(name) && index + 1 < args.length) index += 1;
      continue;
    }
    // Positional message or @file data: never an option; scanning continues.
  }

  const sessionDir = env === undefined ? undefined : env[SESSION_DIR_ENV];
  if (typeof sessionDir === "string" && sessionDir.length > 0) {
    throw new SessionHostStartupOptionError(`session host startup override is not accepted: ${SESSION_DIR_ENV}`);
  }
}

module.exports = {
  assertSessionHostStartupOptions,
  SessionHostStartupOptionError,
  SESSION_DIR_ENV,
};
