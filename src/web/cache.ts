import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebFetchConfig } from "../config";
import { downloadText } from "./network";
import { extractWebPage, findInWebPage, renderWebPage, type ExtractedWebPage, type RenderedWebPage, type WebPageFindResult } from "./page";

interface CacheEntry {
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  contentType: string;
  bytes: number;
  diskBytes: number;
  lastAccessedAt: number;
  page: ExtractedWebPage;
  rawPath: string;
  indexPath: string;
}

export interface WebFetchResult extends RenderedWebPage {
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  contentType: string;
  downloadedBytes: number;
  cacheHit: boolean;
  title: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  tables: ExtractedWebPage["tables"];
  pagination: ExtractedWebPage["pagination"];
  dynamicContentSuspected: boolean;
  dynamicContentReasons: string[];
  find?: WebPageFindResult;
}

export class WebPageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private root?: string;
  private totalBytes = 0;

  constructor(
    private readonly config: WebFetchConfig,
    private readonly downloader: typeof downloadText = downloadText,
  ) {}

  async fetch(input: {
    url: string;
    index?: number;
    maxChars?: number;
    refresh?: boolean;
    find?: string;
    columns?: string[];
    signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    const requestedUrl = normalizedUrl(input.url);
    let entry = input.refresh ? undefined : this.entries.get(requestedUrl);
    const cacheHit = Boolean(entry);
    if (!entry) {
      if (input.refresh) await this.removeEntry(requestedUrl);
      entry = await this.download(requestedUrl, input.signal);
      this.entries.set(requestedUrl, entry);
      this.totalBytes += entry.diskBytes;
      await this.evict(requestedUrl);
    }
    entry.lastAccessedAt = Date.now();
    const maxChars = Math.max(1_000, Math.min(input.maxChars ?? this.config.maxOutputChars, this.config.maxOutputChars));
    const requestedIndex = input.index ?? 0;
    if (input.find && input.columns) throw new Error("find and columns cannot be used together; find the table first, then fetch its index with columns.");
    const found = input.find ? findInWebPage(entry.page, input.find, requestedIndex) : undefined;
    const rendered = found
      ? { content: "", startIndex: requestedIndex, endIndex: requestedIndex, totalBlocks: entry.page.blocks.length }
      : renderWebPage(entry.page, requestedIndex, maxChars, input.columns);
    return {
      ...rendered,
      requestedUrl,
      finalUrl: entry.finalUrl,
      fetchedAt: entry.fetchedAt,
      contentType: entry.contentType,
      downloadedBytes: entry.bytes,
      cacheHit,
      title: entry.page.title,
      ...(entry.page.byline ? { byline: entry.page.byline } : {}),
      ...(entry.page.siteName ? { siteName: entry.page.siteName } : {}),
      ...(entry.page.excerpt ? { excerpt: entry.page.excerpt } : {}),
      tables: entry.page.tables,
      pagination: entry.page.pagination,
      dynamicContentSuspected: entry.page.dynamicContentSuspected,
      dynamicContentReasons: entry.page.dynamicContentReasons,
      ...(found ? { find: found } : {}),
    };
  }

  async cleanup(): Promise<void> {
    const root = this.root;
    this.root = undefined;
    this.entries.clear();
    this.totalBytes = 0;
    if (root) await rm(root, { recursive: true, force: true });
  }

  cleanupSync(): void {
    const root = this.root;
    this.root = undefined;
    this.entries.clear();
    this.totalBytes = 0;
    if (root) rmSync(root, { recursive: true, force: true });
  }

  cacheRoot(): string | undefined {
    return this.root;
  }

  private async download(requestedUrl: string, signal?: AbortSignal): Promise<CacheEntry> {
    const downloaded = await this.downloader(requestedUrl, {
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxDownloadBytes,
      userAgent: this.config.userAgent,
      signal,
    });
    const page = extractWebPage(downloaded.text, downloaded.finalUrl);
    const root = await this.ensureRoot();
    const key = createHash("sha256").update(requestedUrl).digest("hex");
    const rawPath = join(root, `${key}.source`);
    const indexPath = join(root, `${key}.json`);
    const serialized = `${JSON.stringify({
      requestedUrl,
      finalUrl: downloaded.finalUrl,
      fetchedAt: downloaded.fetchedAt,
      contentType: downloaded.contentType,
      page,
    })}\n`;
    await Promise.all([
      writeFile(rawPath, downloaded.text, { encoding: "utf8", mode: 0o600 }),
      writeFile(indexPath, serialized, { encoding: "utf8", mode: 0o600 }),
    ]);
    return {
      requestedUrl,
      finalUrl: downloaded.finalUrl,
      fetchedAt: downloaded.fetchedAt,
      contentType: downloaded.contentType,
      bytes: downloaded.bytes,
      diskBytes: Buffer.byteLength(downloaded.text, "utf8") + Buffer.byteLength(serialized, "utf8"),
      lastAccessedAt: Date.now(),
      page,
      rawPath,
      indexPath,
    };
  }

  private async ensureRoot(): Promise<string> {
    this.root ??= await mkdtemp(join(tmpdir(), "pi-review-web-cache-"));
    return this.root;
  }

  private async evict(protectedUrl: string): Promise<void> {
    while (this.entries.size > this.config.cacheMaxEntries || this.totalBytes > this.config.cacheMaxBytes) {
      const oldest = [...this.entries.values()]
        .filter((entry) => entry.requestedUrl !== protectedUrl || this.entries.size === 1)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)[0];
      if (!oldest) break;
      await this.removeEntry(oldest.requestedUrl);
      if (oldest.requestedUrl === protectedUrl) break;
    }
  }

  private async removeEntry(url: string): Promise<void> {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.entries.delete(url);
    this.totalBytes = Math.max(0, this.totalBytes - entry.diskBytes);
    await Promise.all([
      rm(entry.rawPath, { force: true }),
      rm(entry.indexPath, { force: true }),
    ]);
  }
}

function normalizedUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid URL: ${value}`); }
  url.hash = "";
  return url.href;
}
