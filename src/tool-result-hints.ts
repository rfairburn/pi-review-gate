/**
 * Backwards-compatible tool-result adapter for the shared native expansion
 * hints (see ./presentation-hints — the #92 phase 1 generic core that the
 * #93 tool-result rollout now consumes).
 *
 * Every export here is a direct re-export of the shared presentation hint
 * mechanism, so existing tool/hint consumers and tests keep their imports
 * while the actual logic lives in one non-tool-specific module:
 *
 * - `ToolResultViewComponent` is the same structural component shape, kept as
 *   an alias of the generic `PresentationViewComponent`.
 * - `withExpansionHint`, `expansionHint`, `visibleLineWidth`,
 *   `setNativeExpansionHost`, and `EXPANSION_KEYBINDING_ID` are the shared
 *   functions themselves, not copies.
 *
 * The generic core handles the hint for every expanded presentation row;
 * see ./presentation-hints for the full integration contract (native key
 * resolution, width-safe wrapped fallbacks, handler forwarding, no competing
 * toggle machinery).
 */

import type { PresentationViewComponent } from "./presentation-hints";

export {
  EXPANSION_KEYBINDING_ID,
  expansionHint,
  setNativeExpansionHost,
  visibleLineWidth,
  withExpansionHint,
  type NativeExpansionHost,
} from "./presentation-hints";

/** Tool-result name for the shared structural view component shape. */
export type ToolResultViewComponent = PresentationViewComponent;