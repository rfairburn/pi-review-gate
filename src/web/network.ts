import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { Agent, request, type Dispatcher } from "undici";
import { isBlockedAddress } from "./ip";
import type { BrokerDial } from "./egress-broker";

export interface NetworkOptions {
  timeoutMs: number;
  maxBytes: number;
  userAgent: string;
  signal?: AbortSignal;
  method?: "GET" | "POST";
  body?: string;
  /**
   * Seam for deterministic tests: hostname-to-address resolver used for every
   * per-hop validation. Defaults to the operating system resolver. Production
   * callers never set this.
   */
  resolveHostname?: HostResolver;
  /**
   * Seam for deterministic tests: builds the per-hop dispatcher. Production
   * callers never set this; the default pins the connection to exactly the
   * addresses returned by the immediately preceding validation.
   */
  createDispatcher?: (validated: ValidatedUrl) => Dispatcher;
  /**
   * Seam for deterministic tests: dials the BrowserExtract egress broker's
   * outbound sockets. Production callers never set this; the default dials
   * exactly one validated public address (IPv4 preferred).
   */
  brokerDial?: BrokerDial;
}

/** Bounded omission diagnostics disclosed by a BrowserExtract render. */
export interface BrowserOmissions {
  /** Total omissions: retained samples plus any dropped beyond the cap. */
  count: number;
  /** True when more omissions occurred than the bounded entry list holds. */
  truncated: boolean;
  /** Bounded sample of omission diagnostics (each entry is length-bounded). */
  entries: readonly string[];
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
  /** Present only for BrowserExtract: bounded omissions of subresources. */
  browserOmissions?: BrowserOmissions;
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
  const resolve = options.resolveHostname ?? defaultHostResolver;
  const createDispatcher = options.createDispatcher ?? createPinnedAgent;
  const requested = await validatePublicUrl(url, resolve);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${options.timeoutMs}ms.`)), options.timeoutMs);
  timeout.unref?.();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Request cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const dispatchers: Dispatcher[] = [];
  try {
    let current = requested;
    let method = options.method ?? "GET";
    let body = options.body;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      // Each hop dials through a dispatcher whose lookup only knows the
      // addresses validated immediately above for this exact hop; a per-hop
      // dispatcher also guarantees earlier hops cannot be reused for a
      // destination that was never validated.
      const dispatcher = createDispatcher(current);
      dispatchers.push(dispatcher);
      let response: Dispatcher.ResponseData;
      try {
        response = await request(current.href, {
          dispatcher,
          signal: controller.signal,
          method,
          ...(method === "POST" && body !== undefined ? { body } : {}),
          headers: {
            "user-agent": options.userAgent,
            accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.2",
            "accept-language": "en-US,en;q=0.8",
            // Unlike global fetch, undici.request does not transparently
            // decompress; never invite an encoding we cannot decode.
            "accept-encoding": "identity",
            ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
        });
      } catch (error) {
        throw new Error(`Network request failed for ${current.href}: ${errorDiagnostic(error)}`, { cause: error });
      }
      // Dispatcher teardown can surface ClientDestroyedError on any response
      // body that the caller abandons. Attach the sink before inspecting
      // status or headers so those expected teardown errors cannot escape as
      // uncaught stream errors.
      response.body.on("error", ignoreStreamError);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = headerValue(response.headers, "location");
        if (!location) {
          response.body.destroy();
          throw new Error(`HTTP ${response.statusCode} redirect omitted Location.`);
        }
        if (redirects === 5) {
          response.body.destroy();
          throw new Error("Redirect limit exceeded.");
        }
        // Abandon the redirect response body together with its connection so an
        // unterminated stream cannot hold the dispatcher open; discarding an
        // unread body surfaces as UND_ERR_ABORTED on the stream, which is
        // intentionally swallowed.
        response.body.destroy();
        current = await validatePublicUrl(new URL(location, current.href).href, resolve);
        if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.body.destroy();
        throw new Error(`HTTP ${response.statusCode}`.trim());
      }
      const declared = Number(headerValue(response.headers, "content-length") || "0");
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        response.body.destroy();
        throw new Error(`Response declares ${declared} bytes; limit is ${options.maxBytes}.`);
      }
      const bytes = await readBoundedBody(response.body, options.maxBytes, controller.signal);
      const contentType = headerValue(response.headers, "content-type");
      return {
        requestedUrl: requested.href,
        finalUrl: current.href,
        contentType: contentType || "application/octet-stream",
        text: decodeResponseText(contentType || null, bytes),
        data: bytes,
        bytes: bytes.byteLength,
        fetchedAt: new Date().toISOString(),
      };
    }
    throw new Error("Redirect limit exceeded.");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    // Reliable teardown: every per-hop dispatcher (and its pinned sockets) is
    // destroyed even when validation, connection, or body reading throws.
    await Promise.allSettled(dispatchers.map((dispatcher) => dispatcher.destroy()));
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
  const helper = resolveDdgsHelperPath();
  return await new Promise<DdgsSearchOutput>((resolveResult, reject) => {
    // -I keeps Python from honoring PYTHON* environment variables and from
    // placing the current directory on sys.path, matching the isolated-mode
    // posture used by scripts/ensure-ddgs.sh during provisioning.
    const child = spawn(python, ["-I", helper], { stdio: ["pipe", "pipe", "pipe"] });
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

/** Resolve the packaged DDGS bridge relative to this compiled module. */
export function resolveDdgsHelperPath(): string {
  return resolve(__dirname, "../../../scripts/ddgs-search.py");
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

async function readBoundedBody(body: Readable, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Errors on a body we intentionally abandon (timeout, size cap) must not
  // become unhandled rejections.
  body.on("error", ignoreStreamError);
  try {
    for await (const chunk of body) {
      if (signal.aborted) throw signal.reason;
      const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += next.byteLength;
      if (size > maxBytes) throw new Error(`Downloaded response exceeded ${maxBytes} bytes.`);
      chunks.push(next);
    }
  } finally {
    // Never leave an unterminated response stream holding the connection.
    body.destroy();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function ignoreStreamError(): void {
  // Expected for intentionally abandoned bodies when their dispatcher closes.
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return first ?? "";
}

/** Resolves one hostname to every address the DNS answer currently carries. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export const defaultHostResolver: HostResolver = async (hostname) => {
  if (isIP(hostname)) return [hostname];
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
};

export interface ValidatedUrl {
  /** Canonical URL (WHATWG-normalized, fragment stripped) for this hop. */
  href: string;
  /** Lowercase hostname without IPv6 brackets. */
  hostname: string;
  /** Every address the validation-time DNS answer contained, all pre-validated public. */
  addresses: readonly string[];
}

/**
 * SSRF gate for one exact URL/hop: validates the URL and resolves the hostname
 * once, returning the canonical href, hostname, and every validated public
 * address. Callers must dial only the returned addresses (see
 * `createPinnedLookup` / `createPinnedAgent`); re-resolving later would reopen
 * the DNS rebinding window.
 */
export async function validatePublicUrl(value: string, resolve: HostResolver = defaultHostResolver): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not allowed.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolve(hostname);
  if (addresses.length === 0) throw new Error(`Hostname did not resolve: ${hostname}`);
  for (const address of addresses) {
    if (isBlockedAddress(address)) throw new Error(`URL resolves to a non-public address: ${address}`);
  }
  url.hash = "";
  return { href: url.href, hostname, addresses: [...addresses] };
}

/** Backwards-compatible convenience wrapper returning only the canonical href. */
export async function validatedPublicUrl(value: string, resolve?: HostResolver): Promise<string> {
  return (await validatePublicUrl(value, resolve)).href;
}

/**
 * A net/tls-compatible `lookup` function (same contract as `dns.lookup`) that
 * answers ONLY from the pinned address set. It never consults the operating
 * system resolver, so a DNS answer that changes between validation and connect
 * cannot redirect the socket: any hostname outside the pin set — including the
 * same hostname resolved again through real DNS — fails closed.
 */
export type PinnedLookup = LookupFunction;

export function createPinnedLookup(pins: ReadonlyMap<string, readonly string[]>): PinnedLookup {
  return (hostname, options, callback) => {
    const rawFamily = options.family;
    const family = rawFamily === 4 || rawFamily === "IPv4" ? 4 : rawFamily === 6 || rawFamily === "IPv6" ? 6 : 0;
    const pinned = pins.get(hostname.toLowerCase());
    if (!pinned || pinned.length === 0) {
      callback(
        new Error(
          `DNS pinning blocked resolution of ${hostname}: only addresses validated immediately before this request may be contacted.`,
        ),
        "",
        0,
      );
      return;
    }
    const matches = pinned.filter((address) => family === 0 || isIP(address) === family);
    if (matches.length === 0) {
      callback(new Error(`No validated IPv${family} address is pinned for ${hostname}.`), "", 0);
      return;
    }
    if (options.all) {
      callback(null, matches.map((address) => ({ address, family: isIP(address) })));
      return;
    }
    callback(null, matches[0]!, isIP(matches[0]!));
  };
}

/**
 * Production dispatcher for one validated hop: its socket lookup dials only
 * the validated addresses while the request keeps the original hostname for
 * the HTTP Host header, TLS SNI, and certificate validation.
 */
export function createPinnedAgent(validated: ValidatedUrl): Dispatcher {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(new Map([[validated.hostname, validated.addresses]])),
    },
  });
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
