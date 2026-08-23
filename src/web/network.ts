import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseHTML } from "linkedom";

export interface NetworkOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  signal?: AbortSignal;
}

export interface DownloadedText {
  requestedUrl: string;
  finalUrl: string;
  contentType: string;
  text: string;
  bytes: number;
  fetchedAt: string;
}

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchResponse {
  provider: "duckduckgo";
  query: string;
  results: SearchResult[];
  fetchedAt: string;
  durationMs: number;
}

export async function downloadText(url: string, options: NetworkOptions): Promise<DownloadedText> {
  const requested = await validatedPublicUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${options.timeoutMs}ms.`)), options.timeoutMs);
  timeout.unref?.();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Request cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let current = requested;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": options.userAgent,
            accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.2",
            "accept-language": "en-US,en;q=0.8",
          },
        });
      } catch (error) {
        throw new Error(`Network request failed for ${current}: ${errorDiagnostic(error)}`, { cause: error });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`HTTP ${response.status} redirect omitted Location.`);
        if (redirects === 5) throw new Error("Redirect limit exceeded.");
        current = await validatedPublicUrl(new URL(location, current).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        throw new Error(`Response declares ${declared} bytes; limit is ${options.maxBytes}.`);
      }
      const bytes = await readBoundedBody(response, options.maxBytes, controller.signal);
      return {
        requestedUrl: requested,
        finalUrl: current,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        text: new TextDecoder(charsetOf(response.headers.get("content-type"))).decode(bytes),
        bytes: bytes.byteLength,
        fetchedAt: new Date().toISOString(),
      };
    }
    throw new Error("Redirect limit exceeded.");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function searchDuckDuckGo(input: {
  query: string;
  maxResults: number;
  region?: string;
  freshness?: "day" | "week" | "month" | "year";
  domain?: string;
  options: NetworkOptions;
}): Promise<SearchResponse> {
  const startedAt = Date.now();
  const query = `${input.query.trim()}${input.domain ? ` site:${input.domain.trim()}` : ""}`;
  if (!query) throw new Error("Search query cannot be empty.");
  const target = new URL("https://html.duckduckgo.com/html/");
  target.searchParams.set("q", query);
  if (input.region) target.searchParams.set("kl", input.region);
  if (input.freshness) target.searchParams.set("df", freshnessCode(input.freshness));
  const downloaded = await downloadText(target.href, {
    ...input.options,
    maxBytes: Math.min(input.options.maxBytes, 2 * 1024 * 1024),
  });
  const results = parseDuckDuckGoResults(downloaded.text, input.maxResults);
  if (results.length === 0) {
    const { document } = parseHTML(downloaded.text);
    const body = cleanText(document.body?.textContent ?? "");
    if (/captcha|automated|unusual traffic|challenge/i.test(body)) {
      throw new Error("DuckDuckGo rejected the request with an automated-traffic challenge.");
    }
  }
  return {
    provider: "duckduckgo",
    query: input.query.trim(),
    results,
    fetchedAt: downloaded.fetchedAt,
    durationMs: Date.now() - startedAt,
  };
}

export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const { document } = parseHTML(html);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const result of [...document.querySelectorAll(".result")]) {
    const link = result.querySelector("a.result__a") as HTMLAnchorElement | null;
    if (!link) continue;
    const url = unwrapDuckDuckGoUrl(link.getAttribute("href") ?? "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      rank: results.length + 1,
      title: cleanText(link.textContent ?? ""),
      url,
      snippet: cleanText(result.querySelector(".result__snippet")?.textContent ?? ""),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`Downloaded response exceeded ${maxBytes} bytes.`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function validatedPublicUrl(value: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error(`Hostname did not resolve: ${hostname}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) throw new Error(`URL resolves to a non-public address: ${address}`);
  }
  url.hash = "";
  return url.href;
}

function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0] ?? address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  const parts = ipv4.split(".").map(Number);
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  if (a !== undefined && a >= 224) return true;
  return false;
}

function unwrapDuckDuckGoUrl(value: string): string | undefined {
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    const target = redirected ? new URL(redirected) : url;
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    target.hash = "";
    return target.href;
  } catch {
    return undefined;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function freshnessCode(value: "day" | "week" | "month" | "year"): string {
  return { day: "d", week: "w", month: "m", year: "y" }[value];
}

function charsetOf(contentType: string | null): string {
  const charset = contentType?.match(/charset=([^;\s]+)/i)?.[1]?.replace(/["']/g, "");
  return charset || "utf-8";
}

function errorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) return `${error.message}: ${cause.message}`;
  return error.message;
}
