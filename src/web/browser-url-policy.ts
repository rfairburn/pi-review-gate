import { validatePublicUrl, type HostResolver, type UrlValidationOptions } from "./network.js";
import { bounded } from "./browser-primitives.js";

/**
 * URL policy helpers for the interactive browser (issue #153): navigation
 * URL validation with hash restoration, bounded public-URL reporting and
 * redaction, interaction-origin identity checks, BrowserWait URL matching
 * (safe RE2 only), and the route admission decision. Decisions are pure
 * functions of (resource type, URL); no session or manager state is read.
 */

const SAFE_LOCAL_PROTOCOLS = new Set(["about:", "blob:", "data:"]);

export function interactiveRouteDecision(resourceType: string, rawUrl: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allowed: false, reason: "unparseable browser request blocked" }; }
  // WebSockets use the separately validated per-tab native transport. Ordinary
  // rendering, SSE and beacon HTTP traffic use the authenticated broker.
  if (resourceType === "websocket") {
    return { allowed: false, reason: `${resourceType} resource blocked` };
  }
  if (SAFE_LOCAL_PROTOCOLS.has(url.protocol)) return { allowed: true };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `external protocol ${url.protocol} blocked` };
  }
  return { allowed: true };
}

type Re2Matcher = { test(value: string): boolean };
type Re2Constructor = new (pattern: string, flags?: string) => Re2Matcher;
let SafeRE2: Re2Constructor | null = null;
try {
  SafeRE2 = (require("re2-wasm") as { RE2: Re2Constructor }).RE2;
} catch {
  SafeRE2 = null;
}

export function urlWaitMatcher(kind: "exact" | "prefix" | "pattern", value: string): (url: string) => boolean {
  if (kind === "exact" || kind === "prefix") {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`BrowserWait URL ${kind} value must be an absolute HTTP(S) URL.`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`BrowserWait URL ${kind} value must use HTTP(S).`);
    const expected = parsed.href;
    return kind === "exact" ? (url) => url === expected : (url) => url.startsWith(expected);
  }
  if (kind !== "pattern") throw new Error("BrowserWait URL match must be exact, prefix, or pattern.");
  if (!SafeRE2) throw new Error("BrowserWait safe RE2 matching is unavailable in this runtime.");
  let matcher: Re2Matcher;
  try {
    matcher = new SafeRE2(value, "u");
  } catch {
    throw new Error("BrowserWait URL pattern is invalid or unsupported by safe RE2.");
  }
  return (url) => {
    try { return matcher.test(url); }
    catch { throw new Error("BrowserWait URL pattern could not safely inspect the current URL."); }
  };
}

export function interactionIdentityUrl(rawUrl: string): string {
  if (rawUrl.length > 4_096) throw new Error("Browser interaction URL exceeds the bounded policy limit.");
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser interaction URL is not HTTP(S).");
  }
  return rawUrl;
}

export function redactedInteractionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[redacted URL]";
    return bounded(parsed.origin, 300);
  } catch {
    return "[redacted URL]";
  }
}

export function safePublicPageUrl(rawUrl: string): string {
  try { return publicPageUrl(rawUrl); }
  catch { return "[navigation pending]"; }
}

/** Reported requested URL for a visibility replacement: public URLs bounded
 * as usual; non-public actual page URLs (about:blank, file://) are reported
 * bounded as-is so the intended tab information is never silently dropped. */
export function boundedVisibilityUrl(rawUrl: string): string {
  try { return publicPageUrl(rawUrl); }
  catch { return bounded(rawUrl, 2_048); }
}

export function optionalPublicPageUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try { return publicPageUrl(rawUrl); }
  catch { return null; }
}

export function publicPageUrl(rawUrl: string): string {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Browser ended at an invalid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Browser ended at blocked protocol ${url.protocol}.`);
  return bounded(url.href, 2_048);
}

export async function validateNavigationUrl(
  rawUrl: string,
  resolveHostname: HostResolver,
  options?: UrlValidationOptions,
): Promise<URL> {
  // Shared fetch/cache validation deliberately canonicalizes away fragments.
  // Restore only the hash; authority validation and broker egress are unchanged.
  const validated = await validatePublicUrl(rawUrl, resolveHostname, options);
  const navigation = new URL(validated.href);
  navigation.hash = new URL(rawUrl).hash;
  return navigation;
}
