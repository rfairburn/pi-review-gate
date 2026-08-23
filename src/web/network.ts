import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseHTML } from "linkedom";

export interface NetworkOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  body?: string;
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
  hostname: string;
  snippet: string;
  snippetQuality?: "weak";
  dateText?: string;
  dateSource?: "provider";
}

export interface SearchResponse {
  provider: "duckduckgo";
  query: string;
  nextCursor?: string;
  excludedDomains?: string[];
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
    let method = options.method ?? "GET";
    let body = options.body;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          method,
          ...(method === "POST" && body !== undefined ? { body } : {}),
          headers: {
            "user-agent": options.userAgent,
            accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.2",
            "accept-language": "en-US,en;q=0.8",
            ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
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
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
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
  excludeDomains?: string[];
  cursor?: string;
  options: NetworkOptions;
  download?: typeof downloadText;
}): Promise<SearchResponse> {
  const startedAt = Date.now();
  const requestedQuery = input.query.trim();
  if (!requestedQuery) throw new Error("Search query cannot be empty.");
  const domain = input.domain ? normalizeSearchDomain(input.domain) : undefined;
  const excludedDomains = [...new Set((input.excludeDomains ?? []).map(normalizeSearchDomain))];
  if (domain && excludedDomains.includes(domain)) throw new Error(`Search domain ${domain} cannot also be excluded.`);
  const query = [requestedQuery, domain ? `site:${domain}` : "", ...excludedDomains.map((value) => `-site:${value}`)]
    .filter(Boolean)
    .join(" ");
  const identity = JSON.stringify({ query, region: input.region?.trim() ?? "", freshness: input.freshness ?? "" });
  const initialParameters = new URLSearchParams({ q: query });
  if (input.region) initialParameters.set("kl", input.region);
  if (input.freshness) initialParameters.set("df", freshnessCode(input.freshness));
  const request = input.cursor
    ? decodeSearchCursor(input.cursor, query, identity)
    : { method: "GET" as const, parameters: Object.fromEntries(initialParameters), start: 0, rankOffset: 0, identity };
  const target = new URL("https://html.duckduckgo.com/html/");
  const requestParameters = new URLSearchParams(request.parameters);
  if (request.method === "GET") target.search = requestParameters.toString();
  const downloaded = await (input.download ?? downloadText)(target.href, {
    ...input.options,
    maxBytes: Math.min(input.options.maxBytes, 2 * 1024 * 1024),
    method: request.method,
    ...(request.method === "POST" ? { body: requestParameters.toString() } : {}),
  });
  const pageResults = parseDuckDuckGoResults(downloaded.text, 100);
  const results = pageResults.slice(request.start, request.start + input.maxResults).map((result, index) => ({
    ...result,
    rank: request.rankOffset + request.start + index + 1,
  }));
  if (pageResults.length === 0) {
    const { document } = parseHTML(downloaded.text);
    const body = cleanText(document.body?.textContent ?? "");
    if (/captcha|automated|unusual traffic|challenge/i.test(body)) {
      throw new Error("DuckDuckGo rejected the request with an automated-traffic challenge.");
    }
  }
  const nextStart = request.start + results.length;
  const continuation = nextStart < pageResults.length
    ? { ...request, start: nextStart }
    : parseDuckDuckGoContinuation(downloaded.text, query, request.rankOffset + pageResults.length, identity);
  return {
    provider: "duckduckgo",
    query: requestedQuery,
    ...(continuation ? { nextCursor: encodeSearchCursor(continuation) } : {}),
    ...(excludedDomains.length > 0 ? { excludedDomains } : {}),
    results,
    fetchedAt: downloaded.fetchedAt,
    durationMs: Date.now() - startedAt,
  };
}

interface SearchCursor {
  method: "GET" | "POST";
  parameters: Record<string, string>;
  start: number;
  rankOffset: number;
  identity: string;
}

export function parseDuckDuckGoContinuation(html: string, query: string, rankOffset: number, identity: string): SearchCursor | undefined {
  const { document } = parseHTML(html);
  for (const form of [...document.querySelectorAll("form")]) {
    const submit = form.querySelector('input[type="submit"]') as HTMLInputElement | null;
    if (!/^next$/i.test(cleanText(submit?.getAttribute("value") ?? ""))) continue;
    const parameters: Record<string, string> = {};
    for (const input of [...form.querySelectorAll('input[type="hidden"], input:not([type])')]) {
      const name = input.getAttribute("name");
      if (name) parameters[name] = input.getAttribute("value") ?? "";
    }
    if (parameters.q && parameters.q !== query) continue;
    parameters.q = query;
    return { method: "POST", parameters, start: 0, rankOffset, identity };
  }
  return undefined;
}

function encodeSearchCursor(value: SearchCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString("base64url");
}

function decodeSearchCursor(value: string, query: string, identity: string): SearchCursor {
  if (value.length > 12_000) throw new Error("Search cursor is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Search cursor is invalid.");
  }
  if (!isCursorRecord(parsed) || parsed.v !== 1 || (parsed.method !== "GET" && parsed.method !== "POST")) {
    throw new Error("Search cursor is invalid.");
  }
  const start = parsed.start;
  const rankOffset = parsed.rankOffset;
  if (typeof start !== "number" || !Number.isInteger(start) || start < 0 || start > 100 || typeof rankOffset !== "number" || !Number.isInteger(rankOffset) || rankOffset < 0 || rankOffset > 10_000) {
    throw new Error("Search cursor is invalid.");
  }
  if (!isCursorRecord(parsed.parameters) || Object.keys(parsed.parameters).length > 32) throw new Error("Search cursor is invalid.");
  const parameters: Record<string, string> = {};
  for (const [name, field] of Object.entries(parsed.parameters)) {
    if (typeof field !== "string" || name.length > 80 || field.length > 4_000) throw new Error("Search cursor is invalid.");
    parameters[name] = field;
  }
  if (parsed.identity !== identity || parameters.q !== query) throw new Error("Search cursor does not match this query or its filters.");
  return { method: parsed.method, parameters, start, rankOffset, identity };
}

function isCursorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const { document } = parseHTML(html);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const result of [...document.querySelectorAll(".result")]) {
    const link = result.querySelector("a.result__a") as HTMLAnchorElement | null;
    if (!link) continue;
    const url = unwrapDuckDuckGoUrl(link.getAttribute("href") ?? "");
    if (!url) continue;
    const canonical = canonicalSearchUrl(url);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const snippet = cleanText(result.querySelector(".result__snippet")?.textContent ?? "");
    const dateText = providerDateText(result, snippet);
    results.push({
      rank: results.length + 1,
      title: cleanText(link.textContent ?? ""),
      url,
      hostname: new URL(url).hostname,
      snippet,
      ...(isWeakSnippet(snippet) ? { snippetQuality: "weak" as const } : {}),
      ...(dateText ? { dateText, dateSource: "provider" as const } : {}),
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

export function canonicalSearchUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParameter(name)) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  const search = url.searchParams.toString();
  return `${hostname}${url.port ? `:${url.port}` : ""}${pathname}${search ? `?${search}` : ""}`;
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
    for (const name of [...target.searchParams.keys()]) {
      if (isTrackingParameter(name)) target.searchParams.delete(name);
    }
    target.searchParams.sort();
    return target.href;
  } catch {
    return undefined;
  }
}

function providerDateText(result: Element, snippet: string): string | undefined {
  const dateElement = result.querySelector(".result__timestamp, .result__date, time");
  const explicit = cleanText(dateElement?.getAttribute("datetime") ?? dateElement?.textContent ?? "");
  if (explicit) return explicit;
  const month = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
  const prefix = new RegExp(`^(?:Updated\\s+|Published\\s+)?(${month}\\s+\\d{1,2},\\s+\\d{4}|\\d{1,2}\\s+${month}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d+\\s+(?:hours?|days?|weeks?|months?|years?)\\s+ago)(?:\\s*[-–—·|]\\s*)?`, "i");
  return snippet.match(prefix)?.[1];
}

function isWeakSnippet(value: string): boolean {
  return value.length < 40;
}

function isTrackingParameter(name: string): boolean {
  return /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|vero_id)$/i.test(name);
}

function normalizeSearchDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^\.+/, "");
  if (!trimmed || /[\s/:?#@]/.test(trimmed)) throw new Error(`Invalid search domain: ${value}`);
  let hostname: string;
  try {
    hostname = new URL(`https://${trimmed}`).hostname;
  } catch {
    throw new Error(`Invalid search domain: ${value}`);
  }
  if (hostname !== trimmed || !hostname.includes(".")) throw new Error(`Invalid search domain: ${value}`);
  return hostname;
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
