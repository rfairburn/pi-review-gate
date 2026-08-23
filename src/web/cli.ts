#!/usr/bin/env node
import { loadConfig, normalizeConfig, type ReviewGateConfig, type WebConfig } from "../config";
import { renderWithChromium } from "./browser";
import { WebPageCache } from "./cache";
import { searchDuckDuckGo } from "./network";

interface CliRequest {
  id?: string;
  operation: "search" | "fetch" | "browser-extract";
  query?: string;
  url?: string;
  index?: number;
  maxChars?: number;
  maxResults?: number;
  domain?: string;
  excludeDomains?: string[];
  region?: string;
  freshness?: "day" | "week" | "month" | "year";
  cursor?: string;
  refresh?: boolean;
  find?: string;
  columns?: string[];
}

type CliConfig = ReviewGateConfig & { web: WebConfig };

async function main(): Promise<void> {
  const config = cliConfig();
  const cache = new WebPageCache(config.web.fetch);
  const browserCache = new WebPageCache(config.web.fetch, renderWithChromium);
  process.on("exit", () => {
    cache.cleanupSync();
    browserCache.cleanupSync();
  });
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "search") {
      const request = parseSearchArgs(args);
      writeJson(await runRequest(request, cache, browserCache, config));
      return;
    }
    if (command === "fetch") {
      const request = parseFetchArgs(args);
      writeJson(await runRequest(request, cache, browserCache, config));
      return;
    }
    if (command === "browser-extract") {
      const request = parseFetchArgs(args, "browser-extract");
      writeJson(await runRequest(request, cache, browserCache, config));
      return;
    }
    if (command === "batch") {
      const input = await readStdin();
      for (const line of input.split(/\r?\n/).filter((value) => value.trim())) {
        let request: CliRequest;
        try { request = JSON.parse(line) as CliRequest; } catch (error) {
          writeJson({ ok: false, error: { message: `Invalid NDJSON: ${messageOf(error)}` } });
          continue;
        }
        writeJson(await runRequest(request, cache, browserCache, config));
      }
      return;
    }
    if (command === "doctor") {
      writeJson({
        ok: true,
        operation: "doctor",
        data: {
          node: process.version,
          provider: config.web.search.provider,
          webEnabled: config.web.enabled,
          limits: config.web,
        },
      });
      return;
    }
    throw new Error("Usage: pi-review-web search QUERY [options] | fetch URL [options] | browser-extract URL [options] | batch | doctor");
  } finally {
    await Promise.all([cache.cleanup(), browserCache.cleanup()]);
  }
}

async function runRequest(request: CliRequest, cache: WebPageCache, browserCache: WebPageCache, config: CliConfig): Promise<Record<string, unknown>> {
  try {
    if (request.operation === "search") {
      if (!request.query?.trim()) throw new Error("search requires query");
      const data = await searchDuckDuckGo({
        query: request.query,
        maxResults: bounded(request.maxResults, 1, config.web.search.maxResults, config.web.search.maxResults, "maxResults"),
        ...(request.domain ? { domain: request.domain } : {}),
        ...(request.excludeDomains ? { excludeDomains: request.excludeDomains } : {}),
        ...(request.region ? { region: request.region } : {}),
        ...(request.freshness ? { freshness: request.freshness } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        options: {
          timeoutMs: config.web.search.timeoutMs,
          maxBytes: 2 * 1024 * 1024,
          userAgent: config.web.fetch.userAgent,
        },
      });
      return envelope(request, data);
    }
    if (request.operation === "fetch" || request.operation === "browser-extract") {
      if (!request.url?.trim()) throw new Error(`${request.operation} requires url`);
      const data = await (request.operation === "browser-extract" ? browserCache : cache).fetch({
        url: request.url,
        index: bounded(request.index, 0, Number.MAX_SAFE_INTEGER, 0, "index"),
        maxChars: bounded(request.maxChars, 1_000, config.web.fetch.maxOutputChars, config.web.fetch.maxOutputChars, "maxChars"),
        refresh: request.refresh === true,
        ...(request.find?.trim() ? { find: request.find.trim() } : {}),
        ...(request.columns ? { columns: request.columns } : {}),
      });
      return envelope(request, data);
    }
    throw new Error(`Unsupported operation: ${String(request.operation)}`);
  } catch (error) {
    return {
      protocolVersion: 1,
      ...(request.id ? { id: request.id } : {}),
      ok: false,
      operation: request.operation,
      error: { message: messageOf(error) },
    };
  }
}

function parseSearchArgs(args: string[]): CliRequest {
  const parsed = parseOptions(args);
  const query = parsed.positionals.join(" ").trim();
  return {
    operation: "search",
    query,
    maxResults: numberOption(parsed.options, "max-results"),
    domain: parsed.options.domain,
    excludeDomains: parsed.options["exclude-domains"]?.split(",").map((value) => value.trim()).filter(Boolean),
    region: parsed.options.region,
    freshness: parsed.options.freshness as CliRequest["freshness"],
    cursor: parsed.options.cursor,
  };
}

function parseFetchArgs(args: string[], operation: "fetch" | "browser-extract" = "fetch"): CliRequest {
  const parsed = parseOptions(args);
  return {
    operation,
    url: parsed.positionals[0],
    index: numberOption(parsed.options, "index"),
    maxChars: numberOption(parsed.options, "max-chars"),
    refresh: parsed.options.refresh === "true",
    find: parsed.options.find,
    columns: parsed.options.columns?.split(",").map((value) => value.trim()).filter(Boolean),
  };
}

function parseOptions(args: string[]): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const name = value.slice(2);
    if (name === "refresh") {
      options.refresh = "true";
      continue;
    }
    const next = args[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${name} requires a value`);
    options[name] = next;
    index += 1;
  }
  return { positionals, options };
}

function numberOption(options: Record<string, string>, name: string): number | undefined {
  if (options[name] === undefined) return undefined;
  const value = Number(options[name]);
  if (!Number.isInteger(value)) throw new Error(`--${name} must be an integer`);
  return value;
}

function bounded(value: number | undefined, min: number, max: number, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) throw new Error(`${field} must be ${min}-${max}`);
  return resolved;
}

function envelope(request: CliRequest, data: unknown): Record<string, unknown> {
  return {
    protocolVersion: 1,
    ...(request.id ? { id: request.id } : {}),
    ok: true,
    operation: request.operation,
    data,
  };
}

function cliConfig(): CliConfig {
  const config = (() => {
    try { return loadConfig().config; } catch { return normalizeConfig({}); }
  })();
  if (!config.web) throw new Error("Normalized configuration omitted web defaults.");
  return config as CliConfig;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, process.stdout.isTTY ? 2 : 0)}\n`);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  return input;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  process.stderr.write(`pi-review-web: ${messageOf(error)}\n`);
  process.exitCode = 1;
});
