import type { TerminalInputModes } from "../../src/session-host/terminal-surface";

/**
 * Test-only comparison of captured and live packet modes, with no defaults or
 * normalization. A synchronized frame opening after publication can withhold
 * live mouse reporting without changing the viewer's source facts. Fixtures
 * must compare modes too; this grants nothing and cannot prevent later changes.
 * Both observations must be present and match all seven manager-fenced fields.
 */
export function terminalInputModesAgree(
  expected: TerminalInputModes | undefined,
  current: TerminalInputModes | undefined,
): boolean {
  if (expected === undefined || current === undefined) return false;
  return expected.kittyFlags === current.kittyFlags
    && expected.applicationCursorKeys === current.applicationCursorKeys
    && expected.applicationKeypad === current.applicationKeypad
    && expected.bracketedPaste === current.bracketedPaste
    && expected.mouseTracking === current.mouseTracking
    && expected.modifyOtherKeys === current.modifyOtherKeys
    && expected.mouseEncoding === current.mouseEncoding;
}
