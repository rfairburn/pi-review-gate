/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for the fixed manager-owned clipboard templates — the two self-contained
 * page scripts that are the only page code a model clipboard read/write ever
 * runs (Playwright serializes them into the page), the honest result-scope
 * vocabulary, and the precise unavailable/denied/failed outcome texts.
 */
import type { BrowserConsequence } from "./browser-interaction-policy.js";

export type BrowserClipboardOperation = "clipboard_read" | "clipboard_write";

/** Honest scope of the clipboard a completed operation reached (issue #27):
 * headless Chromium keeps a per-instance virtual clipboard, while headed
 * desktop Chromium reaches the host system clipboard. */
export type BrowserClipboardScope = "browser-internal" | "host-system";

export interface BrowserClipboardResult {
  session: string;
  tab: string;
  generation: string;
  operation: BrowserClipboardOperation;
  consequence: BrowserConsequence;
  /** True only for interactive human confirmation, never automatic approval. */
  confirmed: boolean;
  approval: "human" | "automatic";
  /** Which clipboard the browser actually used; see BrowserClipboardScope. */
  clipboardScope: BrowserClipboardScope;
  /** Redacted origin of the tab that performed the operation. */
  url: string;
  /** Read operations only: the exact bounded text returned by the browser. */
  text?: string;
  truncated?: boolean;
  originalChars?: number;
  /** Write operations only: character count of the written value (never the value). */
  writtenChars?: number;
}

/** Fixed manager-owned read script; the only page code a clipboard read runs.
 * Playwright serializes it, so it must stay self-contained. */
export const CLIPBOARD_READ_SCRIPT = async (): Promise<{ ok: true; text: string } | { ok: false; reason: "unavailable" | "denied" | "failed" }> => {
  const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  if (!clipboard || typeof clipboard.readText !== "function") return { ok: false, reason: "unavailable" };
  try {
    return { ok: true, text: await clipboard.readText() };
  } catch (error) {
    return { ok: false, reason: error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "failed" };
  }
};

/** Fixed manager-owned write script; the approved value arrives as its only
 * argument and never appears in any page-visible state. */
export const CLIPBOARD_WRITE_SCRIPT = async (value: string): Promise<{ ok: true } | { ok: false; reason: "unavailable" | "denied" | "failed" }> => {
  const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") return { ok: false, reason: "unavailable" };
  try {
    await clipboard.writeText(value);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof DOMException && error.name === "NotAllowedError" ? "denied" : "failed" };
  }
};

export function clipboardUnavailableError(direction: "read" | "write", reason: "unavailable" | "denied" | "failed"): string {
  const nothing = direction === "read" ? "nothing was read." : "nothing was written.";
  if (reason === "unavailable") {
    return `BrowserClipboard not_started: the browser clipboard text API is unavailable on this page; secure-context origins (https, or http on localhost/loopback) are required. ${nothing}`;
  }
  if (reason === "denied") {
    return `BrowserClipboard not_started: the browser refused the clipboard ${direction} for this origin even with the manager-issued permission grant. ${nothing}`;
  }
  return `BrowserClipboard not_started: the browser clipboard ${direction} raised an unexpected error inside the page. ${nothing}`;
}
