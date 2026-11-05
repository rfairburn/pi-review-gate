/**
 * #613 caller-side close chain for a Network pane that was opened through the ONE
 * grouped Settings roster row.
 *
 * The product contract (`returnToSettingsMenu` / `closeSettingsMenu` in
 * `src/session-host/sidebar.ts`) is TWO explicit Escape transitions:
 * - Escape inside a Network pane that was entered from the grouped menu returns
 *   THROUGH that menu: the submenu is redrawn with its other rows, the carried
 *   selection stays on the Network row the operator entered from, and the pane
 *   still owns input (`focus === "form"`);
 * - only the NEXT Escape closes the submenu to the roster (`focus === "sidebar"`,
 *   the submenu selection and the pane's return routing are dropped).
 *
 * A caller that presses ONE Escape and then resumes roster navigation has wrong
 * focus bookkeeping: the UI is still the Settings menu with Network highlighted
 * while the roster selection is still Settings, so the next "move to Settings"
 * is a no-op, the Enter that follows re-opens the Network pane, and every later
 * receipt races the wrong pane. This helper is the whole close from the caller's
 * side: two deliberate writes, each witnessed by the frame the host actually
 * wrote, and the caller's focus bookkeeping updated only once the written roster
 * frame proves sidebar focus.
 *
 * It is deliberately driver-independent. The native Windows ConPTY driver
 * satisfies `NetworkPaneNavigator` structurally — its documented `sendKeys`
 * writes one key and awaits a written frame while the caller owns focus
 * bookkeeping — and the portable Main harness is adapted to the same interface in
 * `tests/session-host-network-settings-close.test.ts`, so this route is proven on
 * a mac/Linux run too. Nothing here claims native Windows evidence, and nothing
 * here changes what the product does.
 */
import {
  NETWORK_ACTION,
  parseRosterFrame,
  selectedRosterEntry,
  SETTINGS_ACTION,
  sidebarPaneLines,
  SIDEBAR_COLUMNS,
} from "./session-host-native-roster-witness";

/** One deliberate lone Escape press. */
export const SETTINGS_ESCAPE = "\x1b";

/** Whichever surface the host says owns input, as a caller records it. */
export type PaneFocus = "sidebar" | "form" | "main";

/** The minimum a caller needs from a driver to run this close chain. */
export interface NetworkPaneNavigator {
  /** The latest frame the host actually wrote. */
  currentText(): string;
  /** One key write, awaited against the next written frame satisfying `predicate`. */
  sendKeys(data: string, description: string, predicate: (frame: string) => boolean): Promise<void>;
  /** The caller's own record of who owns input; the driver never maintains it. */
  focus: PaneFocus;
}

/**
 * The content rows of one written frame. A wide composed frame draws the sidebar
 * pane and the content pane on either side of the layout divider, so only the
 * text right of it is content; a frame that draws no divider (a narrow pane,
 * which is how the same submenu looks without a native surface) is its own
 * content.
 */
function contentRows(frame: string): string[] {
  return frame.split("\n").map((line) => {
    const divider = line.indexOf("\u2502");
    return divider < 0 ? line : line.slice(divider + 1);
  });
}

/** The content pane of one written composed frame, wrapped lines rejoined. */
export function contentPaneText(frame: string): string {
  return contentRows(frame).map((line) => line.trimEnd()).join(" ").replace(/\s+/gu, " ");
}

/** The content-pane row drawn with the selection marker, "" when none is drawn. */
export function contentPaneHighlight(frame: string): string {
  for (const line of contentRows(frame)) {
    if (line.startsWith("> ")) return line;
  }
  return "";
}

/** True only while the grouped Settings submenu itself is on screen. */
export function settingsSubmenuOnScreen(frame: string): boolean {
  const pane = contentPaneText(frame);
  return pane.includes("Theme") && pane.includes("Host shortcuts");
}

/**
 * Receipt for the FIRST Escape: the Settings submenu that opened the pane is
 * drawn again, still carrying the Network row as its selection.
 */
export function settingsMenuReturnReceipt(frame: string): boolean {
  return settingsSubmenuOnScreen(frame) && contentPaneHighlight(frame).includes(NETWORK_ACTION);
}

/**
 * Roster-footer hints this receipt requires. `e edit name` and `d stop/remove`
 * are what proves focus: `src/session-host/sidebar.ts` adds them to the footer
 * only while `_focus === "sidebar"`, so a frame that merely redrew the roster
 * rows underneath the Settings menu or a Network pane cannot satisfy this. The
 * rest are the roster's own action hints, required exactly as the shipped
 * `isSidebarFocusedFrame` witness requires them. The toggle hint is deliberately
 * left out because it names the host's configured toggle key (`F8` on the native
 * runners, `Alt+Left` in the synthetic harness); the native acceptance asserts
 * that complete witness itself.
 */
const ROSTER_FOCUS_HINTS = [
  "enter open", "e edit name", "d stop/remove", "esc hide", "q quit",
] as const;

/**
 * Receipt for the SECOND Escape: the strict parser sees a COMPLETE roster whose
 * single selected row is the grouped Settings row, the sidebar pane carries the
 * roster-only footer hints, and no submenu row is left in the content pane. A
 * footer that settled while the submenu was still drawn, a partial repaint, or a
 * selection that never came back to the roster is not this receipt.
 */
export function rosterReturnReceipt(frame: string): boolean {
  if (!parseRosterFrame(frame, SIDEBAR_COLUMNS).complete) return false;
  if (selectedRosterEntry(frame, SIDEBAR_COLUMNS)?.label !== SETTINGS_ACTION) return false;
  const pane = sidebarPaneLines(frame, SIDEBAR_COLUMNS).join(" ").replace(/\s+/gu, " ");
  return ROSTER_FOCUS_HINTS.every((hint) => pane.includes(hint)) && !settingsSubmenuOnScreen(frame);
}

/**
 * Closes a Network pane opened through the grouped Settings row the way the
 * product routes it: Network -> the written Settings submenu -> the written
 * roster, and only then records sidebar focus for the caller.
 */
export async function closeNetworkThroughSettings(driver: NetworkPaneNavigator, label: string): Promise<void> {
  await driver.sendKeys(SETTINGS_ESCAPE, `${label}: Escape returns to the Settings menu that opened Network`,
    settingsMenuReturnReceipt);
  await driver.sendKeys(SETTINGS_ESCAPE, `${label}: the second Escape closes Settings to the roster`,
    rosterReturnReceipt);
  driver.focus = "sidebar";
}
