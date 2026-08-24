import { PDFParse } from "pdf-parse";
import type { ExtractedWebPage, PdfMetadata, WebPageBlock } from "./page";

const MAX_BLOCK_CHARS = 7_000;

export function isPdfResponse(contentType: string, data: Uint8Array | undefined, text = ""): boolean {
  const bytes = data ?? (text.slice(0, 1_024).includes("%PDF-") ? Buffer.from(text, "latin1") : undefined);
  if (!bytes) return false;
  return /(?:^|;)\s*application\/pdf(?:\s*;|$)/i.test(contentType) || hasPdfMagic(bytes);
}

export async function extractPdfDocument(data: Uint8Array, url: string): Promise<ExtractedWebPage> {
  // PDF.js may transfer (and detach) the supplied ArrayBuffer. Parse a copy so
  // the cache can still persist the original network bytes afterward.
  const parser = new PDFParse({ data: new Uint8Array(data) });
  try {
    // PDF.js loading is shared by this parser instance; keep its public parse
    // operations serialized rather than racing two consumers over one document.
    const infoResult = await parser.getInfo().catch(() => undefined);
    const textResult = await parser.getText();
    const blocks: WebPageBlock[] = [];
    let extractedCharacters = 0;
    for (const page of textResult.pages) {
      const text = normalizePdfText(page.text);
      extractedCharacters += text.length;
      if (!text) continue;
      const parts = splitText(text, MAX_BLOCK_CHARS - 32);
      for (const [partIndex, part] of parts.entries()) {
        const heading = `## Page ${page.num}${partIndex > 0 ? " (continued)" : ""}`;
        blocks.push({ index: blocks.length, kind: "text", markdown: `${heading}\n\n${part}`, pageNumber: page.num });
      }
    }
    const info = asRecord(infoResult?.info);
    const dates = infoResult?.getDateNode();
    const metadata = compactMetadata({
      author: optionalMetadata(info.Author),
      subject: optionalMetadata(info.Subject),
      creator: optionalMetadata(info.Creator),
      producer: optionalMetadata(info.Producer),
      creationDate: dateString(dates?.CreationDate),
      modificationDate: dateString(dates?.ModDate),
    });
    const pageCount = textResult.total;
    const scannedOrImageOnlySuspected = pageCount > 0 && extractedCharacters < Math.min(80, pageCount * 10);
    return {
      url,
      title: optionalMetadata(info.Title) ?? titleFromUrl(url),
      documentType: "pdf",
      blocks,
      tables: [],
      pagination: [],
      dynamicContentSuspected: false,
      dynamicContentReasons: [],
      pageCount,
      ...(Object.keys(metadata).length > 0 ? { pdfMetadata: metadata } : {}),
      scannedOrImageOnlySuspected,
    };
  } catch (error) {
    throw new Error(pdfErrorMessage(error), { cause: error });
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

function hasPdfMagic(data: Uint8Array): boolean {
  return Buffer.from(data.subarray(0, Math.min(data.byteLength, 1_024))).toString("latin1").includes("%PDF-");
}

function normalizePdfText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitText(value: string, maxChars: number): string[] {
  if (value.length <= maxChars) return [value];
  const output: string[] = [];
  let remaining = value;
  while (remaining.length > maxChars) {
    const candidates = [remaining.lastIndexOf("\n\n", maxChars), remaining.lastIndexOf("\n", maxChars), remaining.lastIndexOf(" ", maxChars)];
    const splitAt = candidates.find((candidate) => candidate >= Math.floor(maxChars * 0.5)) ?? maxChars;
    output.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) output.push(remaining);
  return output;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function optionalMetadata(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dateString(value: Date | null | undefined): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
}

function compactMetadata(value: PdfMetadata): PdfMetadata {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as PdfMetadata;
}

function titleFromUrl(value: string): string {
  try {
    const pathname = decodeURIComponent(new URL(value).pathname);
    const filename = pathname.split("/").filter(Boolean).at(-1)?.replace(/\.pdf$/i, "").trim();
    return filename || "PDF document";
  } catch {
    return "PDF document";
  }
}

function pdfErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (/password/i.test(name) || /password|encrypted/i.test(message)) {
    return "PDF extraction failed because the document is encrypted or password-protected.";
  }
  if (/invalid pdf|malformed|corrupt|format error|unsupported type|DataCloneError/i.test(`${name} ${message}`)) {
    return `PDF extraction failed because the document is invalid or corrupt: ${message}`;
  }
  return `PDF extraction failed: ${message}`;
}
