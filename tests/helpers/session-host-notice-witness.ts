/**
 * Strict, pure witness for the session-host sidebar's bounded `! <message>`
 * refusal notice (#323), shared by the legacy Main harness and its pure
 * regression tests.
 *
 * The production contract (src/session-host/sidebar.ts) renders a roster
 * error as `! ${noticeError}` word-wrapped across consecutive pane rows above
 * the footer, each row padded to the sidebar width. In the wide layout those
 * rows occupy the leftmost 32 columns of the composed frame, separated from
 * the native right pane by one divider column; a wrap therefore places the
 * divider inside any full-frame join and can never be matched by a contiguous
 * substring.
 *
 * This witness is fail-closed: it reports the notice only when the complete
 * message — every word, in order, including its final punctuation — is
 * reconstructed exactly from consecutive non-blank sidebar-pane rows. Clipped
 * or truncated notices, missing or altered words, and text that exists only
 * in the native pane (outside the sidebar columns) are all rejected. No PTY,
 * SDK, child process, command, install, or home/Git read is performed.
 */
import { SIDEBAR_COLUMNS, sidebarPaneLines } from "./session-host-native-roster-witness";

/**
 * Reconstructs the complete `! <message>` notice from a composed host frame
 * (or raw sidebar pane) text, scoped to the actual sidebar columns so native
 * right-pane text can never stand in for it.
 *
 * Returns the exact rendered notice rows (trailing padding removed) when the
 * complete message is drawn word-wrapped across consecutive non-blank rows;
 * undefined when any part of the message is missing, altered, clipped, or
 * absent from the sidebar columns. Wrap points are not pinned: any
 * word-wrap of the complete message is admitted, and no shorter or different
 * text is.
 */
export function sidebarNoticeRows(
  text: string,
  message: string,
  sidebarColumns: number = SIDEBAR_COLUMNS,
): string[] | undefined {
  const target = `! ${message}`;
  const pane = sidebarPaneLines(text, sidebarColumns).map((line) => line.trimEnd());
  for (let start = 0; start < pane.length; start += 1) {
    const first = pane[start]!;
    if (!first.startsWith("! ")) continue;
    let joined = first;
    const rows = [first];
    if (joined === target) return rows;
    for (let cursor = start + 1; cursor < pane.length && pane[cursor] !== ""; cursor += 1) {
      joined = `${joined} ${pane[cursor]}`;
      rows.push(pane[cursor]!);
      if (joined === target) return rows;
      if (joined.length > target.length) break;
    }
  }
  return undefined;
}
