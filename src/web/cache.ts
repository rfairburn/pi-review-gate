import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebFetchConfig } from "../config";
import type { BrowserOmissions } from "./network";
import { downloadText } from "./network";
import {
  EMPTY_URL_BLOCKLIST,
  urlBlocklistsEqual,
  type UrlBlocklist,
  type UrlGuard,
} from "./url-blocklist";
import { ColumnProjectionError, extractFetchedDocument, findInWebPage, renderWebPage, type ExtractedWebPage, type RenderedWebPage, type WebPageFindResult } from "./page";
import { extractPdfDocument, isPdfResponse } from "./pdf";

interface CacheEntry {
  requestedUrl: string;
  finalUrl: string;
  fetchedAt: string;
  contentType: string;
  bytes: number;
  diskBytes: number;
  lastAccessedAt: number;
  page: ExtractedWebPage;
  browserOmissions?: BrowserOmissions;
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
  documentType: ExtractedWebPage["documentType"];
  pageCount?: number;
  pdfMetadata?: ExtractedWebPage["pdfMetadata"];
  scannedOrImageOnlySuspected?: boolean;
  /** Present only for BrowserExtract acquisitions: bounded subresource omissions. */
  browserOmissions?: BrowserOmissions;
  find?: WebPageFindResult;
}

export class WebPageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private root?: string;
  private totalBytes = 0;
  /**
   * Bumped whenever a shared URL blocklist change invalidates the cache, so an
   * acquisition that started under the earlier policy can be recognized and
   * kept out of the cache (issue #620).
   */
  private policyGeneration = 0;

  constructor(
    private config: WebFetchConfig,
    private readonly downloader: typeof downloadText = downloadText,
    private urlBlocklist: UrlBlocklist = EMPTY_URL_BLOCKLIST,
  ) {}

  /**
   * Apply a saved configuration. A CHANGED shared URL blocklist also
   * invalidates every cached acquisition (issue #620): entries were fetched
   * under the previous policy, and a cached document's earlier redirect hops
   * are not recorded, so nothing cached earlier may serve a URL the new list
   * denies. The generation bump additionally fences acquisitions that were
   * already in flight. An unchanged list keeps the cache intact.
   */
  updateConfig(config: WebFetchConfig, urlBlocklist?: UrlBlocklist): void {
    this.config = config;
    if (urlBlocklist === undefined || urlBlocklistsEqual(this.urlBlocklist, urlBlocklist)) return;
    this.urlBlocklist = urlBlocklist;
    this.policyGeneration += 1;
    this.invalidate();
  }

  async fetch(input: {
    url: string;
    index?: number;
    maxChars?: number;
    refresh?: boolean;
    find?: string;
    columns?: string[];
    signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    // The shared blocklist judges the raw supplied URL — fragment and all —
    // before any cache lookup, so neither a cache hit nor a later policy
    // change can evade a denial. The normalized cache key below loses the
    // fragment for storage only and is never a policy input.
    this.assertSuppliedAllowed(input.url);
    const requestedUrl = normalizedUrl(input.url);
    let entry = input.refresh ? undefined : this.entries.get(requestedUrl);
    const cacheHit = Boolean(entry);
    if (!entry) {
      if (input.refresh) await this.removeEntry(requestedUrl);
      entry = await this.acquire(requestedUrl, input.url, input.signal);
    }
    entry.lastAccessedAt = Date.now();
    const maxChars = Math.max(1_000, Math.min(input.maxChars ?? this.config.maxOutputChars, this.config.maxOutputChars));
    const requestedIndex = input.index ?? 0;
    if (input.find && input.columns) throw new ColumnProjectionError("find and columns cannot be used together; find the table first, then fetch its index with columns.");
    if (input.columns && entry.page.documentType === "pdf") {
      throw new ColumnProjectionError("columns are not available for PDF documents; use find and index to locate and read page-aware text blocks.");
    }
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
      documentType: entry.page.documentType,
      ...(entry.page.pageCount !== undefined ? { pageCount: entry.page.pageCount } : {}),
      ...(entry.page.pdfMetadata ? { pdfMetadata: entry.page.pdfMetadata } : {}),
      ...(entry.page.scannedOrImageOnlySuspected !== undefined
        ? { scannedOrImageOnlySuspected: entry.page.scannedOrImageOnlySuspected }
        : {}),
      ...(entry.browserOmissions ? { browserOmissions: entry.browserOmissions } : {}),
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

  /**
   * Acquire a document and admit it to the cache only when the shared URL
   * blocklist did not change while it was in flight (issue #620). Redirect
   * hops are validated as they happen, so an acquisition that started under an
   * earlier list has never been checked against the new one — admitting it
   * would let a later fetch skip that validation entirely, and a final-URL
   * check cannot cover an intermediate hop. A stale acquisition is discarded and
   * reported as a policy change the caller can retry; it is never re-requested
   * automatically, because fetching again is the caller's decision. The guard
   * installed for the running acquisition follows the current list, so a
   * destination the new list denies is denied before it is contacted.
   */
  private async acquire(requestedUrl: string, suppliedUrl: string, signal?: AbortSignal): Promise<CacheEntry> {
    const generation = this.policyGeneration;
    this.assertSuppliedAllowed(suppliedUrl);
    const entry = await this.download(suppliedUrl, requestedUrl, signal);
    if (this.policyGeneration === generation) {
      this.entries.set(requestedUrl, entry);
      this.totalBytes += entry.diskBytes;
      await this.evict(requestedUrl);
      return entry;
    }
    await Promise.all([
      rm(entry.rawPath, { force: true }),
      rm(entry.indexPath, { force: true }),
    ]);
    throw new Error(
      `The web.urlBlocklist changed while ${requestedUrl} was being acquired; `
      + "the completed acquisition was discarded rather than served from a policy it was not validated against. "
      + "No further request was made. Retry the request.",
    );
  }

  /** Judge the caller's supplied URL exactly as supplied, fragment included. */
  private assertSuppliedAllowed(url: string): void {
    this.urlBlocklist.assertAllowed(url, "initial");
  }

  /**
   * Run one acquisition. The downloader receives the caller's COMPLETE URL —
   * fragment included — so the transport's own policy checks never see a
   * fragmentless stand-in; each downloader canonicalizes its wire request and
   * fragment handling internally. `requestedUrl` stays the fragmentless cache
   * key and stored identity.
   */
  private async download(suppliedUrl: string, requestedUrl: string, signal?: AbortSignal): Promise<CacheEntry> {
    // The guard is installed unconditionally and follows the CURRENT compiled
    // list rather than capturing it: a live settings update can add entries
    // while this acquisition is running, and a route that started without a
    // guard would then contact a destination the new policy denies before the
    // generation fence could reject the result. An empty list denies nothing,
    // so the check stays cheap until an entry exists.
    const urlGuard: UrlGuard = (url, stage) => this.urlBlocklist.assertAllowed(url, stage);
    const downloaded = await this.downloader(suppliedUrl, {
      timeoutMs: this.config.timeoutMs,
      maxBytes: this.config.maxDownloadBytes,
      userAgent: this.config.userAgent,
      signal,
      urlGuard,
    });
    const rawData = downloaded.data
      ?? (downloaded.text.slice(0, 1_024).includes("%PDF-") ? Buffer.from(downloaded.text, "latin1") : undefined);
    const pdf = isPdfResponse(downloaded.contentType, rawData, downloaded.text);
    const page = pdf
      ? await extractPdfDocument(rawData!, downloaded.finalUrl)
      : extractFetchedDocument(downloaded.contentType, downloaded.text, downloaded.finalUrl, {
          rendered: downloaded.rendered === true,
        });
    const root = await this.ensureRoot();
    const key = createHash("sha256").update(requestedUrl).digest("hex");
    const rawPath = join(root, `${key}.source`);
    const indexPath = join(root, `${key}.json`);
    const serialized = `${JSON.stringify({
      requestedUrl,
      finalUrl: downloaded.finalUrl,
      fetchedAt: downloaded.fetchedAt,
      contentType: downloaded.contentType,
      ...(downloaded.browserOmissions ? { browserOmissions: downloaded.browserOmissions } : {}),
      page,
    })}\n`;
    await Promise.all([
      rawData
        ? writeFile(rawPath, rawData, { mode: 0o600 })
        : writeFile(rawPath, downloaded.text, { encoding: "utf8", mode: 0o600 }),
      writeFile(indexPath, serialized, { encoding: "utf8", mode: 0o600 }),
    ]);
    return {
      requestedUrl,
      finalUrl: downloaded.finalUrl,
      fetchedAt: downloaded.fetchedAt,
      contentType: downloaded.contentType,
      bytes: downloaded.bytes,
      diskBytes: (rawData?.byteLength ?? Buffer.byteLength(downloaded.text, "utf8")) + Buffer.byteLength(serialized, "utf8"),
      lastAccessedAt: Date.now(),
      page,
      ...(downloaded.browserOmissions ? { browserOmissions: downloaded.browserOmissions } : {}),
      rawPath,
      indexPath,
    };
  }

  /**
   * Drop every cached acquisition after a shared URL blocklist change, so a
   * document fetched under the earlier policy can never answer a request the
   * new policy denies. Cached files are removed on a best-effort basis; the
   * in-memory entries are gone synchronously, and the cache root is removed in
   * full by the ordinary shutdown cleanup.
   */
  private invalidate(): void {
    const stale = [...this.entries.values()];
    this.entries.clear();
    this.totalBytes = 0;
    void Promise.allSettled(stale.flatMap((entry) => [
      rm(entry.rawPath, { force: true }),
      rm(entry.indexPath, { force: true }),
    ]));
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
