/**
 * Canonical background-shell tool names (issue #653).
 *
 * The one dependency-free source of the names `registerBackgroundShell()` in
 * `./index.ts` registers, so configuration-only consumers (the standalone
 * review-settings catalog) read the same names without importing the process
 * implementation graph. A name here is a configuration candidate only; it
 * never grants, activates, or proves availability of a tool.
 */
export const BACKGROUND_SHELL_TOOL_NAMES = {
  start: "ShellStart",
  list: "ShellList",
  log: "ShellLog",
  send: "ShellSend",
  stop: "ShellStop",
} as const satisfies Record<string, string>;
