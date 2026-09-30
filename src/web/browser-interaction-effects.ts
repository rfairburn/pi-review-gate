/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for the interaction effect ledger — the bounded per-operation capture
 * (dialogs, downloads, popup tabs, network requests and their containment
 * settlements), the bounded accounting window that proves the capture has
 * stabilized, and the single interaction-effect report shape shared by every
 * interaction result. The manager still wires the observed browser events
 * into the active capture; this module owns what the capture holds, how it
 * drains, and the effect report it produces.
 */
import type { BrowserClickButton, BrowserConsequence, BrowserFormOperation } from "./browser-interaction-policy.js";
import type { OperationDeadline } from "./browser-operations.js";
import { settleBrowserReads, within } from "./browser-operations.js";

export type BrowserInteractionEffectState = "not_started" | "started" | "completed" | "unknown";

export interface BrowserInteractionEffects {
  navigation: "observed" | "not_observed";
  observedPopupTabs: number;
  observedOverflowPopupsClosed: number;
  observedDialogsDismissed: number;
  download: "not_observed" | "canceled" | "retained";
  /** Handles of downloads retained as pending during this interaction (issue #27). */
  retainedDownloadHandles?: string[];
  network: "not_observed" | "observed";
  accounting: "bounded_stable" | "bounded_uncertain";
}

export interface BrowserInteractionResult {
  session: string;
  tab: string;
  generation: string;
  operation: "hover" | "click" | BrowserFormOperation | "upload" | "download_save";
  /** Selected mouse button; present only for click operations, including controlled navigation. */
  button?: BrowserClickButton;
  /** Coordinate clicks (issue #141): the dispatched viewport-image point. Absent for ref clicks. */
  coordinate?: { x: number; y: number };
  consequence: BrowserConsequence | "observational";
  /** True only for interactive human confirmation, never automatic approval. */
  confirmed: boolean;
  approval: "not_required" | "human" | "automatic";
  effect: BrowserInteractionEffectState;
  effects: BrowserInteractionEffects;
  url: string;
  /** Upload operations (issue #27): verified source file count and total bytes. Metadata only; no content is ever exposed. */
  uploadedFiles?: number;
  uploadedBytes?: number;
  /** Download-save operations (issue #27): the verified destination path and saved byte count. */
  savedDestination?: string;
  savedBytes?: number;
}

/** Manager-booked observations of one bounded browser interaction. */
export interface InteractionCapture {
  dialogs: number;
  downloads: number;
  /** Handles of downloads retained as pending during this interaction (issue #27). */
  retainedDownloads: string[];
  popupTabs: Set<string>;
  overflowPopups: number;
  networkRequests: number;
  events: number;
  settlements: Promise<void>[];
}

const INTERACTION_ACCOUNTING_MIN_MS = 200;
const INTERACTION_ACCOUNTING_MAX_MS = 250;
const INTERACTION_ACCOUNTING_QUIET_MS = 50;

/** Drain effects added while earlier containment promises are settling. */
export async function accountInteractionEffects(
  capture: InteractionCapture,
  operation: OperationDeadline,
): Promise<"bounded_stable" | "bounded_uncertain"> {
  const startedAt = Date.now();
  const accountingDeadline = startedAt + Math.min(
    INTERACTION_ACCOUNTING_MAX_MS,
    Math.max(1, operation.remainingMs() - 1),
  );
  let cursor = 0;
  let observedEvents = capture.events;
  let stableSince = startedAt;

  while (true) {
    while (cursor < capture.settlements.length) {
      const batch = capture.settlements.slice(cursor);
      cursor = capture.settlements.length;
      const remaining = accountingDeadline - Date.now();
      if (remaining <= 0) throw new Error("Interaction side-effect containment exceeded its bounded accounting window.");
      await operation.run(within(
        settleBrowserReads(batch).then(() => undefined),
        remaining,
        "interaction side-effect containment",
        operation.signal,
      ), "interaction side-effect containment");
    }

    const now = Date.now();
    if (capture.events !== observedEvents) {
      observedEvents = capture.events;
      stableSince = now;
    }
    const minimumObserved = now - startedAt >= INTERACTION_ACCOUNTING_MIN_MS;
    const stable = now - stableSince >= INTERACTION_ACCOUNTING_QUIET_MS;
    if (minimumObserved && stable && cursor === capture.settlements.length) return "bounded_stable";
    if (now >= accountingDeadline) return "bounded_uncertain";

    const delayMs = Math.max(1, Math.min(25, accountingDeadline - now));
    await operation.run(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), "interaction effect observation");
  }
}

export function newInteractionCapture(): InteractionCapture {
  return {
    dialogs: 0,
    downloads: 0,
    retainedDownloads: [],
    popupTabs: new Set(),
    overflowPopups: 0,
    networkRequests: 0,
    events: 0,
    settlements: [],
  };
}

/**
 * Single source of truth for the effect report shared by every interaction
 * result (click/hover and form/upload/save paths), kept in one place so the
 * retained-vs-canceled download classification cannot drift between call
 * sites. With model download saving enabled a triggered download is retained
 * (staged privately) instead of canceled; its opaque handles are reported so
 * BrowserDownloadSave can name one explicitly.
 */
export function interactionEffects(
  capture: InteractionCapture,
  navigated: boolean,
  accounting: "bounded_stable" | "bounded_uncertain",
): BrowserInteractionResult["effects"] {
  return {
    navigation: navigated ? "observed" : "not_observed",
    observedPopupTabs: capture.popupTabs.size,
    observedOverflowPopupsClosed: capture.overflowPopups,
    observedDialogsDismissed: capture.dialogs,
    download: capture.retainedDownloads.length > 0 ? "retained" : capture.downloads > 0 ? "canceled" : "not_observed",
    ...(capture.retainedDownloads.length > 0 ? { retainedDownloadHandles: [...capture.retainedDownloads] } : {}),
    network: capture.networkRequests > 0 ? "observed" : "not_observed",
    accounting,
  };
}

export function interactionResult(
  identity: { session: string; tab: string; generation: string; url: string },
  operation: "hover" | "click" | BrowserFormOperation | "upload" | "download_save",
  consequence: BrowserConsequence,
  approval: BrowserInteractionResult["approval"],
  capture: InteractionCapture,
  accounting: "bounded_stable" | "bounded_uncertain",
  navigated: boolean,
): BrowserInteractionResult {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation,
    consequence,
    confirmed: approval === "human",
    approval,
    effect: "completed",
    effects: interactionEffects(capture, navigated, accounting),
    url: identity.url,
  };
}
