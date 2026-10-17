import { findWindowsExecutable } from "./background-shell/shell";

/**
 * Native host support for Pi's builtin `powershell` tool (#421/#94).
 *
 * Pi 1.3 registers the builtin on every platform (`allToolDefinitions`), but
 * its executor (`dist/utils/shell.js` `getPowerShellConfig`) throws outside
 * `win32` and, on Windows, needs `pwsh.exe` or else `powershell.exe` on PATH
 * (Pi docs/windows.md). Review-gate treats the builtin like `bash` only where
 * that host contract holds; it never implements a cross-platform interpreter.
 *
 * Identification uses Pi's public `getAllTools()` provenance (`sourceInfo`):
 * only the entry Pi itself supplied as `builtin:powershell` is subject to the
 * host gate. An extension or SDK tool that happens to be named `powershell`
 * owns its own runtime and is never filtered here; an entry whose provenance
 * the host does not disclose cannot be proven to be the native builtin and
 * keeps the historical, ungated treatment.
 */
export const NATIVE_POWERSHELL_TOOL_NAME = "powershell";

const BUILTIN_SOURCE = "builtin";
const BUILTIN_PATH_PREFIX = "builtin:";

/** Whether one public `getAllTools()` entry is Pi's own native `powershell` builtin. */
export function isNativePowerShellBuiltinEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  if (record.name !== NATIVE_POWERSHELL_TOOL_NAME) return false;
  const sourceInfo = record.sourceInfo;
  if (typeof sourceInfo !== "object" || sourceInfo === null) return false;
  const source = sourceInfo as Record<string, unknown>;
  return source.source === BUILTIN_SOURCE
    && source.path === `${BUILTIN_PATH_PREFIX}${NATIVE_POWERSHELL_TOOL_NAME}`;
}

/**
 * Probe whether this host can run Pi's native `powershell` builtin: Windows
 * only, with `pwsh.exe` or `powershell.exe` resolvable on PATH — the same
 * discovery order Pi uses. Non-Windows hosts answer without spawning anything.
 * On Windows this runs a bounded synchronous `where` lookup, so callers cache
 * the answer and refresh it only at session start and operating-mode
 * transitions, never per reconciliation. It proves the interpreter is
 * resolvable, not that any particular command will succeed. A probe failure
 * reports unsupported (the builtin is withheld, never widened).
 */
export function probeNativePowerShellHostSupport(
  platform: NodeJS.Platform = process.platform,
  findExecutable: (executable: string) => string | null = findWindowsExecutable,
): boolean {
  if (platform !== "win32") return false;
  try {
    return (findExecutable("pwsh.exe") ?? findExecutable("powershell.exe")) !== null;
  } catch {
    return false;
  }
}
