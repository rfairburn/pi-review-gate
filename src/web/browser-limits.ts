/**
 * Issue #46 browser responsibility decomposition: the authoritative home for
 * the public admission bounds, manager limits defaults, and the pure
 * limit-enforcement checks (screenshot dimension/PNG/clip validation and the
 * bounded interaction-input assertions). `interactive-browser.ts` re-exports
 * the historical public surface; the remaining bound checks move here so the
 * manager module keeps only lifecycle orchestration.
 */
import { BrowserValidationError } from "./browser-errors.js";
import { CLEANUP_DEADLINE_MS } from "./browser.js";
import { asError } from "./browser-primitives.js";

export const BROWSER_INTERACTION_SESSION_MAX_CHARS = 256;
export const BROWSER_INTERACTION_TAB_MAX_CHARS = 256;
export const BROWSER_INTERACTION_REF_MAX_CHARS = 512;
export const BROWSER_FILL_MAX_CHARS = 4_096;
export const BROWSER_TYPE_MAX_CHARS = 1_000;
export const BROWSER_TYPE_MAX_DELAY_MS = 5;
export const BROWSER_SELECT_MAX_OPTIONS = 32;
export const BROWSER_SELECT_OPTION_MAX_CHARS = 256;
export const BROWSER_PRESS_KEY_MAX_CHARS = 32;
// Issue #27 model file-transfer bounds.
export const BROWSER_UPLOAD_MAX_FILES = 32;
export const BROWSER_UPLOAD_PATH_MAX_CHARS = 4_096;
// Issue #27 model clipboard bounds (text only): the write payload matches the
// fill bound, and read output is bounded like snapshot text.
export const BROWSER_CLIPBOARD_WRITE_MAX_CHARS = 4_096;
export const BROWSER_CLIPBOARD_READ_MAX_CHARS = 24_000;
/** Default retained-unsaved-download cap per session; the setting web.browserDownloadRetention configures it (0 disables count-based eviction). */
export const DEFAULT_BROWSER_DOWNLOAD_RETENTION = 8;
export const BROWSER_DOWNLOAD_FILENAME_MAX_CHARS = 512;
export const BROWSER_DOWNLOAD_DESTINATION_MAX_CHARS = 4_096;
export const BROWSER_DIAGNOSTIC_CURSOR_MAX = Number.MAX_SAFE_INTEGER;
export const BROWSER_DIAGNOSTIC_READ_MAX_EVENTS = 64;

// Manager-side admission bounds for page-created ws/wss routes, checked
// before Chromium's native stack is allowed to connect through the session
// broker. The broker independently re-validates and pins every destination.
// These admission bounds are owned by browser-websocket-admission.ts.

/** Hard limits for the initial, observational browser surface. */
export interface InteractiveBrowserLimits {
  maxSessions: number;
  maxTabsPerSession: number;
  maxNavigations: number | null;
  maxActions: number | null;
  maxMainDocumentRequests: number | null;
  maxHistoryEntries: number;
  maxScrollPages: number;
  maxWaitTextChars: number;
  maxWaitPatternChars: number;
  maxWaitMs: number;
  maxSnapshotChars: number;
  maxSnapshotDepth: number;
  maxScreenshotWidth: number;
  maxScreenshotHeight: number;
  maxScreenshotPixels: number;
  maxScreenshotBytes: number;
  maxScreenshotAllocationBytes: number;
  maxConsoleEvents: number;
  maxConsoleTextChars: number;
  maxConsoleSourceChars: number;
  maxNetworkEvents: number;
  maxDiagnosticReadEvents: number;
  maxInspectTextChars: number;
  maxInspectNameChars: number;
  maxInspectDescriptionChars: number;
  navigationMs: number;
  actionMs: number;
  confirmationMs: number;
  idleSocketMs: number;
  cleanupMs: number;
  maxDistinctHosts: number | null;
  maxConnections: number | null;
  maxRequests: number | null;
  maxConnectionBytes: number | null;
  maxTotalBytes: number | null;
}

export const INTERACTIVE_BROWSER_LIMITS: Readonly<InteractiveBrowserLimits> = Object.freeze({
  maxSessions: 1,
  maxTabsPerSession: 4,
  // Lifetime accounting is not a session-expiry policy. Individual operations
  // retain their deadlines and output bounds; test overrides can impose quotas.
  maxNavigations: null,
  maxActions: null,
  maxMainDocumentRequests: null,
  maxHistoryEntries: 32,
  maxScrollPages: 3,
  maxWaitTextChars: 512,
  maxWaitPatternChars: 512,
  maxWaitMs: 10_000,
  maxSnapshotChars: 24_000,
  maxSnapshotDepth: 16,
  maxScreenshotWidth: 2_000,
  maxScreenshotHeight: 2_000,
  maxScreenshotPixels: 4_000_000,
  maxScreenshotBytes: 4 * 1024 * 1024,
  maxScreenshotAllocationBytes: 32 * 1024 * 1024,
  maxConsoleEvents: 256,
  maxConsoleTextChars: 1_000,
  maxConsoleSourceChars: 300,
  maxNetworkEvents: 256,
  maxDiagnosticReadEvents: BROWSER_DIAGNOSTIC_READ_MAX_EVENTS,
  maxInspectTextChars: 512,
  maxInspectNameChars: 256,
  maxInspectDescriptionChars: 512,
  navigationMs: 30_000,
  actionMs: 10_000,
  confirmationMs: 30_000,
  idleSocketMs: 20_000,
  cleanupMs: CLEANUP_DEADLINE_MS,
  maxDistinctHosts: null,
  maxConnections: null,
  maxRequests: null,
  maxConnectionBytes: null,
  maxTotalBytes: null,
});

export function assertExactText(value: unknown, maxChars: number, emptyAllowed: boolean): asserts value is string {
  if (typeof value !== "string" || (!emptyAllowed && value.length === 0) || value.length > maxChars) {
    throw new Error("Browser form text is absent or exceeds its bounded length.");
  }
}

export function assertSelectValues(values: unknown): asserts values is readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > BROWSER_SELECT_MAX_OPTIONS
    || values.some((value) => typeof value !== "string" || value.length < 1 || value.length > BROWSER_SELECT_OPTION_MAX_CHARS)) {
    throw new Error("Browser option set is absent or exceeds its bounded size.");
  }
  if (new Set(values).size !== values.length) throw new Error("Browser option set must not contain duplicates.");
}

export function normalizeBrowserPressKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > BROWSER_PRESS_KEY_MAX_CHARS || /\s/.test(value)) {
    throw new Error("BrowserPress key is not an allowed key or short chord.");
  }
  const parts = value.split("+");
  if (parts.some((part) => !part) || parts.length > 3) throw new Error("BrowserPress key is not an allowed key or short chord.");
  const base = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  const modifierSet = new Set(modifiers);
  const modifierNames = new Set(["Alt", "Control", "Meta", "Shift"]);
  if (modifierSet.size !== modifiers.length || modifiers.some((part) => !modifierNames.has(part))) {
    throw new Error("BrowserPress key is not an allowed key or short chord.");
  }
  const named = new Set([
    "Enter", "Space", "Tab", "Escape", "Backspace", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  ]);
  const editingChord = ["A", "Y", "Z"].includes(base)
    && modifiers.some((modifier) => modifier === "Control" || modifier === "Meta")
    && modifiers.every((modifier) => modifier === "Control" || modifier === "Meta" || modifier === "Shift");
  if (!named.has(base) && !editingChord) throw new Error("BrowserPress key is not an allowed key or short chord.");
  // Alt/Meta/Control navigation chords are browser-global rather than bounded
  // target actions. Only Shift may modify named keys; activation stays risky.
  if (named.has(base) && modifiers.some((modifier) => modifier !== "Shift")) {
    throw new Error("BrowserPress key is not an allowed key or short chord.");
  }
  return value;
}

export function assertBoundedInteractionCapability(value: string, maxChars: number): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) {
    throw new Error("Browser interaction capability is absent or exceeds its bounded length.");
  }
}

/** Issue #141 viewport-mode screenshot defaults; matches the context's fixed viewport. */
export const DEFAULT_VIEWPORT_WIDTH = 1_280;
export const DEFAULT_VIEWPORT_HEIGHT = 720;

/**
 * Issue #141: validate requested viewport-mode screenshot dimensions. Integer
 * bounds and the existing screenshot image/allocation limits apply exactly as
 * for the fixed viewport; out-of-range requests are rejected before any
 * capture or resize happens as recoverable caller-input validation errors
 * (BrowserValidationError never contains the operation fail-closed).
 */
export function assertViewportScreenshotDimensions(
  viewport: { width: number; height: number },
  limits: InteractiveBrowserLimits,
): void {
  if (!Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height)
    || viewport.width < 1 || viewport.height < 1) {
    throw new BrowserValidationError("BrowserScreenshot viewport dimensions must be positive integers.");
  }
  try {
    assertScreenshotDimensions(viewport.width, viewport.height, limits, "viewport");
  } catch (error) {
    throw new BrowserValidationError(asError(error).message);
  }
}

/**
 * Issue #141: bounded input validation for requested coordinate clicks. The
 * bounds against the recorded screenshot dimensions are checked with the
 * reference at click time; this validates plain numeric sanity only.
 */
export function assertCoordinateClickInput(x: number, y: number): void {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0) {
    throw new BrowserValidationError("not_started: BrowserClick coordinates must be non-negative integers in viewport image (CSS) pixels.");
  }
}

export function boundedElementClip(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  limits: Readonly<InteractiveBrowserLimits>,
): { x: number; y: number; width: number; height: number } {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
    throw new Error("BrowserScreenshot element has invalid bounds.");
  }
  // Use an enclosing integer clip so fractional CSS pixels cannot increase the
  // decoded output beyond the preflight calculation.
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);
  const width = right - x;
  const height = bottom - y;
  assertScreenshotDimensions(width, height, limits, "element clip");
  if (x < 0 || y < 0 || right > viewport.width || bottom > viewport.height) {
    throw new Error(
      "BrowserScreenshot element does not fit completely within the bounded viewport after positioning.",
    );
  }
  return { x, y, width, height };
}

function assertScreenshotDimensions(
  width: number,
  height: number,
  limits: Readonly<InteractiveBrowserLimits>,
  label: string,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`BrowserScreenshot ${label} has invalid dimensions.`);
  }
  const normalizedWidth = Math.ceil(width);
  const normalizedHeight = Math.ceil(height);
  const pixels = normalizedWidth * normalizedHeight;
  const rawAllocation = pixels * 4;
  if (
    normalizedWidth > limits.maxScreenshotWidth
    || normalizedHeight > limits.maxScreenshotHeight
    || !Number.isSafeInteger(pixels)
    || pixels > limits.maxScreenshotPixels
    || rawAllocation > limits.maxScreenshotAllocationBytes
  ) {
    throw new Error(
      `BrowserScreenshot ${label} exceeds the bounded image limits `
      + `(${normalizedWidth}x${normalizedHeight}, ${pixels} pixels; maximum `
      + `${limits.maxScreenshotWidth}x${limits.maxScreenshotHeight}, ${limits.maxScreenshotPixels} pixels, `
      + `${limits.maxScreenshotAllocationBytes} allocation bytes).`,
    );
  }
}

export function validatePngScreenshot(
  image: Buffer,
  limits: Readonly<InteractiveBrowserLimits>,
): { width: number; height: number } {
  // PNG's fixed signature and IHDR put dimensions before any page-controlled
  // compressed payload. Playwright was explicitly asked for PNG; reject any
  // malformed or surprising result rather than forwarding opaque bytes.
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (image.byteLength < 24 || !image.subarray(0, 8).equals(signature) || image.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("BrowserScreenshot returned an invalid PNG image.");
  }
  if (image.byteLength > limits.maxScreenshotBytes) {
    throw new Error(`BrowserScreenshot final PNG exceeds the ${limits.maxScreenshotBytes}-byte encoded output limit.`);
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assertScreenshotDimensions(width, height, limits, "final PNG");
  const pixels = width * height;
  const base64Chars = Math.ceil(image.byteLength / 3) * 4;
  // Conservatively charge two bytes per JavaScript string character in
  // addition to decoded RGBA and encoded Buffer storage before allocating the
  // Pi ImageContent string.
  const allocationBytes = pixels * 4 + image.byteLength + base64Chars * 2;
  if (allocationBytes > limits.maxScreenshotAllocationBytes) {
    throw new Error(
      `BrowserScreenshot final image exceeds the ${limits.maxScreenshotAllocationBytes}-byte allocation limit.`,
    );
  }
  return { width, height };
}

export function clampedTestLimit(value: number, hardMaximum: number): number {
  return Number.isFinite(value) ? Math.min(hardMaximum, Math.max(1, Math.floor(value))) : hardMaximum;
}
