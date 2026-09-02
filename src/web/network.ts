import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { isBlockedAddress } from "./ip";

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
  /** Raw response bytes when the acquisition came directly from the network. */
  data?: Uint8Array;
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
  provider: "ddgs";
  query: string;
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
        text: decodeResponseText(response.headers.get("content-type"), bytes),
        data: bytes,
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

export interface DdgsRawResult {
  title: string;
  href: string;
  body: string;
  date?: string;
}

export interface DdgsSearchRequest {
  query: string;
  maxResults: number;
  timeoutMs: number;
  region?: string;
  timelimit?: "d" | "w" | "m" | "y";
}

export interface DdgsSearchOutput {
  results: DdgsRawResult[];
}

export type DdgsRunner = (request: DdgsSearchRequest, signal?: AbortSignal) => Promise<DdgsSearchOutput>;

export async function searchDdgs(input: {
  query: string;
  maxResults: number;
  region?: string;
  freshness?: "day" | "week" | "month" | "year";
  domain?: string;
  excludeDomains?: string[];
  options: Pick<NetworkOptions, "timeoutMs" | "signal">;
  run?: DdgsRunner;
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
  const region = input.region?.trim() || "us-en";
  const request: DdgsSearchRequest = {
    query,
    maxResults: input.maxResults,
    timeoutMs: input.options.timeoutMs,
    region,
    ...(input.freshness ? { timelimit: freshnessCode(input.freshness) } : {}),
  };
  const output = await runDdgsWithRetry(input.run ?? runDdgsSearch, request, input.options.signal);
  const results = normalizeDdgsResults(output.results).slice(0, input.maxResults);
  return {
    provider: "ddgs",
    query: requestedQuery,
    ...(excludedDomains.length > 0 ? { excludedDomains } : {}),
    results,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

async function runDdgsWithRetry(run: DdgsRunner, request: DdgsSearchRequest, signal?: AbortSignal): Promise<DdgsSearchOutput> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const output = await run(request, signal);
      if (output.results.length > 0) return output;
      firstError ??= new Error("DDGS returned no results.");
    } catch (error) {
      if (signal?.aborted) throw error;
      firstError ??= error;
    }
  }
  throw firstError instanceof Error ? firstError : new Error(String(firstError ?? "DDGS returned no results."));
}

export async function runDdgsSearch(request: DdgsSearchRequest, signal?: AbortSignal): Promise<DdgsSearchOutput> {
  if (signal?.aborted) throw new Error("DDGS search was cancelled.");
  const python = process.env.PI_REVIEW_GATE_DDGS_PYTHON || "python3";
  const helper = process.env.PI_REVIEW_GATE_DDGS_HELPER || resolve(__dirname, "../../../scripts/ddgs-search.py");
  return await new Promise<DdgsSearchOutput>((resolveResult, reject) => {
    const child = spawn(python, [helper], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const terminate = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => terminate(new Error(`DDGS search timed out after ${request.timeoutMs}ms.`)), request.timeoutMs);
    timer.unref?.();
    const onAbort = () => terminate(new Error("DDGS search was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2 * 1024 * 1024) terminate(new Error("DDGS helper returned too much data."));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) terminate(new Error("DDGS helper returned too much diagnostic output."));
    });
    child.stdin.on("error", (error) => { failure ??= error; });
    child.on("error", (error) => { failure ??= error; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new Error(`DDGS helper returned invalid JSON${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
        return;
      }
      if (!isRecord(parsed) || parsed.ok !== true) {
        const message = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : stderr.trim();
        reject(new Error(message || `DDGS helper exited with status ${code ?? "unknown"}.`));
        return;
      }
      try {
        resolveResult(parseDdgsOutput(parsed));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function normalizeDdgsResults(rawResults: DdgsRawResult[], rankOffset = 0): SearchResult[] {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const raw of rawResults) {
    const url = normalizedSearchResultUrl(raw.href);
    if (!url) continue;
    const canonical = canonicalSearchUrl(url);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const snippet = cleanText(raw.body);
    const dateText = cleanText(raw.date ?? "") || providerDateFromSnippet(snippet);
    results.push({
      rank: rankOffset + results.length + 1,
      title: cleanText(raw.title) || new URL(url).hostname,
      url,
      hostname: new URL(url).hostname,
      snippet,
      ...(isWeakSnippet(snippet) ? { snippetQuality: "weak" as const } : {}),
      ...(dateText ? { dateText, dateSource: "provider" as const } : {}),
    });
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

export async function validatedPublicUrl(value: string): Promise<string> {
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

function parseDdgsOutput(value: Record<string, unknown>): DdgsSearchOutput {
  if (!Array.isArray(value.results)) throw new Error("DDGS helper returned an invalid result payload.");
  const results = value.results.map((item) => {
    if (!isRecord(item) || typeof item.title !== "string" || typeof item.href !== "string" || typeof item.body !== "string") {
      throw new Error("DDGS helper returned an invalid search result.");
    }
    if (item.date !== undefined && typeof item.date !== "string") throw new Error("DDGS helper returned an invalid provider date.");
    return {
      title: item.title,
      href: item.href,
      body: item.body,
      ...(typeof item.date === "string" && item.date ? { date: item.date } : {}),
    };
  });
  return { results };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedSearchResultUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (isTrackingParameter(name)) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    return url.href;
  } catch {
    return undefined;
  }
}

function providerDateFromSnippet(snippet: string): string | undefined {
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

function freshnessCode(value: "day" | "week" | "month" | "year"): "d" | "w" | "m" | "y" {
  return ({ day: "d", week: "w", month: "m", year: "y" } as const)[value];
}

/**
 * Decode response bytes with the declared charset. Unknown or unsupported
 * labels fall back to UTF-8 so a hostile content-type header cannot let a
 * TextDecoder RangeError escape downloadText.
 */
export function decodeResponseText(contentType: string | null, bytes: Uint8Array): string {
  const charset = charsetOf(contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
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
