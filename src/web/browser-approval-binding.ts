/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for the one-use approval bindings and the fixed human-confirmation
 * prompt templates. Builders take plain identity fields
 * (session/tab/generation strings) plus the exact structures they bind; the
 * target fingerprint is supplied by the manager's consequence policy so the
 * permit digest stays exactly what it was. No state, no permits, and no
 * decision logic live here — issuing, consuming, and revoking the permits
 * stays with the manager's per-operation approval orchestration.
 */
import type {
  BrowserClickButton,
  BrowserConfirmationBinding,
  BrowserConsequence,
  BrowserFormOperation,
} from "./browser-interaction-policy.js";
import { createHash } from "node:crypto";
import { redactedInteractionUrl } from "./browser-url-policy.js";
import { bounded } from "./browser-primitives.js";
import type { BrowserClipboardOperation } from "./browser-clipboard.js";
import type { PendingDownloadRecord, SaveDestinationFacts, ValidatedUploadSources } from "./browser-file-transfer.js";

/** Issue #141: per-tab memory-only reference from the last successful viewport-mode
 * capture (element captures and failed captures never replace it). It supplies the
 * recorded viewport dimensions for coordinate clicks only; generation and origin are
 * provenance of the capture, never a currentness attestation — the page may change
 * after capture and every coordinate click revalidates the live document itself. */
export interface ViewportScreenshotReference {
  generation: string;
  origin: string;
  width: number;
  height: number;
}

export interface BrowserInteractionConfirmationRequest {
  title: string;
  message: string;
}

export type BrowserInteractionConfirmation = (request: BrowserInteractionConfirmationRequest) => Promise<boolean>;
/** Compatibility alias for the original click API. */
export type BrowserClickConfirmation = BrowserInteractionConfirmation;

/** Plain identity fields every binding carries (the same strings the manager holds). */
export interface ConfirmationIdentity {
  session: string;
  tab: string;
  generation: string;
}

export function coordinateClickPrompt(
  origin: string,
  button: BrowserClickButton,
  x: number,
  y: number,
  reference: ViewportScreenshotReference,
): BrowserInteractionConfirmationRequest {
  return {
    title: "Confirm consequential browser click",
    message: [
      `The ${button}-click at screenshot coordinates ${x}, ${y} (viewport ${reference.width}x${reference.height}) is classified as unknown or mixed.`,
      `Current site: ${redactedInteractionUrl(origin)}.`,
      "A coordinate target cannot prove absent page-controlled effects.",
      "Approve this one exact click? The page can have external effects; cancellation does not imply rollback.",
    ].join(" "),
  };
}

export function confirmationPrompt(
  consequence: BrowserConsequence,
  origin: string,
  destination: string | null,
  button: BrowserClickButton = "left",
): BrowserInteractionConfirmationRequest {
  return {
    title: "Confirm consequential browser click",
    message: [
      `The ${button}-click on this target is classified as ${consequence.replaceAll("_", " ")}.`,
      `Current site: ${redactedInteractionUrl(origin)}.`,
      ...(destination ? [`Destination site: ${redactedInteractionUrl(destination)}.`] : []),
      "Approve this one exact click? The page can have external effects; cancellation does not imply rollback.",
    ].join(" "),
  };
}

export function formConfirmationPrompt(
  operation: BrowserFormOperation,
  consequence: BrowserConsequence,
  origin: string,
  destination: string | null,
): BrowserInteractionConfirmationRequest {
  return {
    title: `Confirm consequential browser ${operation}`,
    message: [
      `The exact ${operation} action is classified as ${consequence.replaceAll("_", " ")}.`,
      `Current site: ${redactedInteractionUrl(origin)}.`,
      ...(destination ? [`Destination site: ${redactedInteractionUrl(destination)}.`] : []),
      "The entered or selected content is intentionally hidden.",
      `Approve this one exact ${operation}? The page can have external effects; cancellation does not imply rollback.`,
    ].join(" "),
  };
}

export function clipboardConfirmationPrompt(operation: BrowserClipboardOperation, origin: string, writeChars: number | null): BrowserInteractionConfirmationRequest {
  if (operation === "clipboard_read") {
    return {
      title: "Confirm model clipboard read",
      message: [
        `The browser will read the text currently on the clipboard of the page at ${redactedInteractionUrl(origin)}.`,
        "Clipboard text can contain credentials or other secrets and becomes model-visible result content. Approve this one exact read?",
      ].join(" "),
    };
  }
  return {
    title: "Confirm model clipboard write",
    message: [
      `The browser will replace the text on the clipboard of the page at ${redactedInteractionUrl(origin)} with an approved value of ${writeChars} character(s).`,
      "The exact value is bound to this approval by digest and length only; it is not shown here. Approve this one exact write?",
    ].join(" "),
  };
}

export function uploadConfirmationPrompt(origin: string, sources: ValidatedUploadSources): BrowserInteractionConfirmationRequest {
  const list = sources.files.map((file) => bounded(file.path, 512)).join("; ");
  return {
    title: "Confirm model file upload",
    message: [
      `The browser will upload ${sources.files.length} local file(s) to ${redactedInteractionUrl(origin)}.`,
      `Source files (host paths; content is never shown): ${list}.`,
      "Approve this one exact upload? The page can have external effects; cancellation does not imply rollback.",
    ].join(" "),
  };
}

export function downloadSaveConfirmationPrompt(record: PendingDownloadRecord, destination: SaveDestinationFacts): BrowserInteractionConfirmationRequest {
  return {
    title: "Confirm model download saving",
    message: [
      `The browser will save a completed download${record.url ? ` from ${record.url}` : ""} to ${bounded(destination.real, 1_024)}.`,
      destination.existed
        ? "The destination file already exists and will be replaced."
        : "A new file will be created at the destination.",
      ...(record.suggestedFilename ? [`Suggested name (untrusted page data, not used): ${bounded(record.suggestedFilename, 128)}.`] : []),
      "Approve this one exact save? Cancellation does not imply rollback.",
    ].join(" "),
  };
}

export function digestExactValues(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value)), "utf8");
    hash.update("\0");
    hash.update(value, "utf8");
    hash.update("\0");
  }
  return hash.digest("base64url");
}

/** One-use permit binding for a bounded semantic click target. */
export function confirmationBinding(
  identity: ConfirmationIdentity,
  ref: string,
  origin: string,
  consequence: BrowserConsequence,
  destination: string | null,
  button: BrowserClickButton,
  targetFingerprint: string,
): BrowserConfirmationBinding {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation: "click",
    ref,
    origin,
    destination,
    targetFingerprint,
    consequence,
    valueDigest: null,
    valueLengths: [],
    key: null,
    button,
  };
}

/** Issue #141 permit binding for coordinate clicks: the exact point, button,
 * recorded viewport dimensions, generation, origin, and target fingerprint. */
export function coordinateConfirmationBinding(
  identity: ConfirmationIdentity,
  origin: string,
  consequence: BrowserConsequence,
  button: BrowserClickButton,
  x: number,
  y: number,
  reference: ViewportScreenshotReference,
  targetFingerprint: string,
): BrowserConfirmationBinding {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation: "click",
    ref: "coordinates",
    origin,
    destination: null,
    targetFingerprint,
    consequence,
    valueDigest: null,
    valueLengths: [],
    key: null,
    button,
    point: { x, y },
    viewport: { width: reference.width, height: reference.height },
  };
}

export function formConfirmationBinding(
  identity: ConfirmationIdentity,
  ref: string,
  origin: string,
  consequence: BrowserConsequence,
  destination: string | null,
  operation: BrowserFormOperation,
  valueDigest: string | null,
  valueLengths: readonly number[],
  key: string | null,
  targetFingerprint: string,
): BrowserConfirmationBinding {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation,
    ref,
    origin,
    destination,
    targetFingerprint,
    consequence,
    valueDigest,
    valueLengths,
    key,
    button: null,
  };
}

export function uploadConfirmationBinding(
  identity: ConfirmationIdentity,
  ref: string,
  origin: string,
  sourceFiles: readonly string[],
  targetFingerprint: string,
): BrowserConfirmationBinding {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation: "upload",
    ref,
    origin,
    destination: null,
    targetFingerprint,
    consequence: "file_upload",
    valueDigest: null,
    valueLengths: [],
    key: null,
    button: null,
    sourceFiles,
  };
}

export function clipboardConfirmationBinding(
  identity: ConfirmationIdentity,
  origin: string,
  operation: BrowserClipboardOperation,
  valueDigest: string | null,
  valueLengths: readonly number[],
): BrowserConfirmationBinding {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation,
    ref: "",
    origin,
    destination: null,
    targetFingerprint: "",
    consequence: operation === "clipboard_read" ? "clipboard_read" : "clipboard_write",
    valueDigest,
    valueLengths,
    key: null,
    button: null,
  };
}

export function downloadSaveBinding(
  identity: ConfirmationIdentity,
  record: PendingDownloadRecord,
  destination: SaveDestinationFacts,
): BrowserConfirmationBinding {
  return {
    session: identity.session,
    tab: identity.tab,
    generation: identity.generation,
    operation: "download_save",
    ref: "",
    origin: record.url ?? "",
    destination: null,
    targetFingerprint: "",
    consequence: "file_download_save",
    valueDigest: null,
    valueLengths: [],
    key: null,
    button: null,
    downloadHandle: record.handle,
    destinationPath: destination.real,
    destinationExisted: destination.existed,
  };
}
