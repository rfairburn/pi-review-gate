import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Download } from "playwright";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { InteractiveBrowserManager, type BrowserDownloadListResult } from "../src/web/interactive-browser";

const LIVE_REPORT_BYTES = Buffer.from("live-download-bytes-0123456789-abcdef");
const GATED_REPORT_BYTES = Buffer.from("gated-download-bytes-9876543210-fedcba");
// The default-off case needs its own artifact: a tiny response can fully
// complete before the manager's cancel reaches Chromium, which is a
// legitimate completed transfer (failure() === null) that cannot prove an
// active cancellation. Holding EOF on this route makes in-progress certain.
const DEFAULTOFF_REPORT_BYTES = Buffer.from("defaultoff-download-bytes-0123456789-abcdef");

/**
 * Bounded budget for observing actual download retention or cancellation that
 * lands outside a click's bounded post-dispatch accounting window. This is an
 * observation deadline with real assertions on the outcome, not a retry of the
 * interaction and not an extension of the production window.
 */
const RETENTION_OBSERVE_TIMEOUT_MS = 2_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Boundedly observe the manager's actual retained downloads until exactly
 * `expectedCount` are listed. A late download that is not actually retained
 * still fails here with the final observed listing.
 */
async function observeRetainedDownloads(
  manager: InteractiveBrowserManager,
  session: string,
  tab: string,
  expectedCount: number,
): Promise<BrowserDownloadListResult> {
  const deadline = Date.now() + RETENTION_OBSERVE_TIMEOUT_MS;
  let listing = await manager.listDownloads(session, tab);
  while (listing.downloads.length !== expectedCount) {
    if (Date.now() >= deadline) {
      throw new Error(
        `expected exactly ${expectedCount} retained download(s), observed ${listing.downloads.length}: ${JSON.stringify(listing.downloads)}`,
      );
    }
    await sleep(25);
    listing = await manager.listDownloads(session, tab);
  }
  return listing;
}

interface UploadReceipt { filename: string | null; bodyLength: number; body: Buffer; }

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-live-"));
  const uploadSource = path.join(workspaceRoot, "live-upload.txt");
  const uploadBytes = Buffer.from("live-upload-bytes-9876543210-fedcba");
  await writeFile(uploadSource, uploadBytes);
  const receipts: UploadReceipt[] = [];
  // Deliberately held response for the gated-download case: the browser's
  // download event can only arrive after the test releases it, which is always
  // after a click's bounded accounting window has closed.
  let releaseGatedFile: (() => void) | undefined;
  const gatedFileHeld = new Promise<void>((resolve) => { releaseGatedFile = resolve; });
  let gatedResponse: ServerResponse | undefined;
  // Deliberately held response for the default-off case: headers and initial
  // bytes are sent immediately, then EOF is withheld until the download is
  // canceled or teardown releases it. The real browser download is therefore
  // guaranteed to still be in progress when the manager cancels it, so the
  // observed failure is deterministically "canceled".
  let releaseDefaultOffFile: (() => void) | undefined;
  const defaultOffFileHeld = new Promise<void>((resolve) => { releaseDefaultOffFile = resolve; });
  let defaultOffResponse: ServerResponse | undefined;
  // Records that the request was actually served by the held route: the
  // determinism of the cancellation proof depends on it, so a later edit that
  // repoints the link (or ends this response immediately) must fail loudly
  // instead of silently restoring the completion-before-cancel race.
  let defaultOffServed = false;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>File transfer fixture</title>
        <form action="/upload" method="post" enctype="multipart/form-data">
          <input type="file" name="file" aria-label="Upload">
        </form>
        <a href="/file" download aria-label="Get report">Report</a>
        <a href="/gated-file" download aria-label="Get gated report">Gated report</a>
        <a href="/defaultoff-file" download aria-label="Get default-off report">Default-off report</a>
        <script>
          document.querySelector('input[type="file"]').addEventListener('change', (event) => {
            const file = event.target.files[0];
            if (!file) return;
            const form = new FormData();
            form.append("file", file);
            fetch("/upload", { method: "POST", body: form });
          });
        </script>`);
      return;
    }
    if (request.method === "GET" && request.url === "/file") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="live-report.bin"',
      });
      response.end(LIVE_REPORT_BYTES);
      return;
    }
    if (request.method === "GET" && request.url === "/gated-file") {
      gatedResponse = response;
      await gatedFileHeld;
      if (response.destroyed) return;
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="gated-report.bin"',
      });
      response.end(GATED_REPORT_BYTES);
      return;
    }
    if (request.method === "GET" && request.url === "/defaultoff-file") {
      defaultOffServed = true;
      defaultOffResponse = response;
      // Bounded cleanup: a client abort (the manager's cancel) or teardown
      // must never leave this handler holding the socket. The response's
      // close event only fires once the transfer has ended or been aborted,
      // never while EOF is still withheld.
      const releaseHold = () => { releaseDefaultOffFile?.(); };
      response.on("close", releaseHold);
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="defaultoff-report.bin"',
      });
      // Initial bytes are in flight while EOF is withheld: the download
      // cannot complete before the manager's cancel, so the cancellation is
      // of a genuinely in-progress transfer with real bytes already sent.
      response.write(DEFAULTOFF_REPORT_BYTES.subarray(0, 16));
      await defaultOffFileHeld;
      if (response.destroyed) return;
      response.end(DEFAULTOFF_REPORT_BYTES.subarray(16));
      return;
    }
    if (request.method === "POST" && request.url === "/upload") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const filename = /filename="([^"]*)"/.exec(request.headers["content-type"] ?? "")?.[1]
          ?? /name="file"; *filename="([^"]*)"/.exec(body.toString("latin1"))?.[1]
          ?? null;
        receipts.push({ filename, bodyLength: body.length, body });
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("ok");
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://file-transfer.test:${(server.address() as AddressInfo).port}`;
  let browser!: Browser;
  // Preflight validates against a public address; the broker dial is pointed
  // at the local fixture server (same pattern as the browser-safety suite).
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: (_validated, port) => net.connect({ host: "127.0.0.1", port }),
    launch: async options => browser = await chromium.launch(options),
    workspaceRoot,
  });
  const opened = await manager.open(`${origin}/`);
  return {
    manager, browser, opened, origin, receipts, uploadSource, uploadBytes, workspaceRoot, LIVE_REPORT_BYTES, GATED_REPORT_BYTES,
    get defaultOffServed() { return defaultOffServed; },
    releaseGatedFile: () => { releaseGatedFile?.(); },
    async ref(label: string) {
      const snapshot = await manager.snapshot(opened.session, opened.tab, 10_000);
      const line = snapshot.snapshot.split("\n").find((line) => line.includes(`"${label}"`) && line.includes("[ref="));
      const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
      assert.ok(ref, snapshot.snapshot);
      return ref;
    },
    async close() {
      // Release and drop the deliberately held downloads so teardown cannot
      // hang on an in-flight response, even when a test fails before its own
      // assertions would have released them.
      releaseGatedFile?.();
      gatedResponse?.destroy();
      releaseDefaultOffFile?.();
      defaultOffResponse?.destroy();
      await manager.shutdown();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

test("live browser: default-off file transfer stays denied while human uploads are unaffected", async () => {
  const f = await fixture();
  try {
    const page = f.browser.contexts()[0]!.pages()[0]!;
    // Model download saving is off by default: the approved click still
    // triggers a real download, but the manager cancels it and retains nothing.
    // The dedicated /defaultoff-file route holds EOF after headers and initial
    // bytes, so the download is guaranteed to still be in progress when the
    // manager cancels it (a tiny artifact could otherwise complete first, a
    // legitimate completed transfer that reports failure() === null). Observe
    // the real browser download directly so the actual cancellation can be
    // awaited independent of the click's bounded accounting window (a late
    // event truthfully reports not_observed).
    let observedDownload: Download | undefined;
    page.on("download", (download) => { observedDownload ??= download; });
    const before = f.receipts.length;
    const clicked = await f.manager.click(f.opened.session, f.opened.tab, await f.ref("Get default-off report"), async () => true);
    // Truthful in-window classification: canceled when the event landed inside
    // the bounded window, not_observed when it did not; capability off must
    // never retain.
    assert.ok(
      clicked.effects.download === "canceled" || clicked.effects.download === "not_observed",
      `model download saving is off; the effect must never be retained (got ${clicked.effects.download})`,
    );
    assert.equal(clicked.effects.retainedDownloadHandles, undefined);
    // Await the real download and its actual cancellation (bounded), then prove
    // nothing was retained rather than accepting a permissive union.
    const deadline = Date.now() + RETENTION_OBSERVE_TIMEOUT_MS;
    while (!observedDownload) {
      if (Date.now() >= deadline) throw new Error("the real browser download was not observed within the bounded window");
      await sleep(25);
    }
    // The browser only started a download after receiving this fixture's
    // response headers, so the held route must have served it: without that,
    // the in-progress guarantee below no longer holds.
    assert.ok(f.defaultOffServed, "the default-off download must be served by the held route");
    // Bounded observation of the terminal state: a cancel that never reaches
    // a terminal downloadProgress (a future engine regression) must fail with
    // a diagnosis instead of hanging until the CI job timeout. The strict
    // expectation stays "canceled"; the deadline only labels a missing state.
    let failureTimer: ReturnType<typeof setTimeout> | undefined;
    const failureDeadline = new Promise<never>((_, reject) => {
      failureTimer = setTimeout(
        () => reject(new Error("the canceled download did not reach a terminal state within the bounded window")),
        RETENTION_OBSERVE_TIMEOUT_MS,
      );
    });
    try {
      assert.equal(await Promise.race([observedDownload.failure(), failureDeadline]), "canceled", "the default-off policy must actually cancel the real download");
    } finally {
      clearTimeout(failureTimer);
    }
    assert.deepEqual((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads, []);
    // Model uploads are off by default: the precise capability denial names
    // the permission and no file is read or sent.
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await f.ref("Upload"), [f.uploadSource], async () => true),
      /not_started: model file uploads are disabled by the managed-browser permissions; no file was read or sent\./,
    );
    assert.equal(f.receipts.length, before);
    // Human interaction is unaffected: a direct setInputFiles (what a human in
    // the visible browser does) still reaches the server with exact bytes.
    await page.locator('input[type="file"]').setInputFiles(f.uploadSource);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.receipts.length, before + 1);
    const receipt = f.receipts[f.receipts.length - 1]!;
    assert.equal(receipt.filename, path.basename(f.uploadSource));
    assert.ok(receipt.body.includes(f.uploadBytes), "the human upload carries the exact file bytes");
  } finally { await f.close(); }
});

test("live browser: approved model upload and download saving move real bytes", async () => {
  const f = await fixture();
  try {
    const config = normalizeConfig({});
    f.manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelUploads: true, modelDownloadSaving: true });
    // Model upload through the real engine: the server must receive the exact
    // bytes of the host file chosen by the model.
    let uploadPrompt: { title: string; message: string } | undefined;
    const uploaded = await f.manager.upload(f.opened.session, f.opened.tab, await f.ref("Upload"), [f.uploadSource], async (request) => {
      uploadPrompt = request;
      return true;
    });
    assert.equal(uploaded.operation, "upload");
    assert.equal(uploaded.approval, "human");
    assert.equal(uploaded.uploadedFiles, 1);
    assert.equal(uploaded.uploadedBytes, f.uploadBytes.length);
    assert.ok(uploadPrompt!.message.includes("1 local file(s)"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.receipts.length, 1);
    const receipt = f.receipts[0]!;
    assert.equal(receipt.filename, path.basename(f.uploadSource));
    assert.ok(receipt.body.includes(f.uploadBytes), "the model upload carries the exact file bytes");
    // Model download saving: an approved click retains the real staged
    // artifact, and the approved save writes it to the session working dir.
    const clicked = await f.manager.click(f.opened.session, f.opened.tab, await f.ref("Get report"), async () => true);
    // Truthful in-window classification only: a download event that lands after
    // the click's bounded accounting window reports not_observed, while the
    // retention policy applies at event time, independent of that window.
    assert.ok(
      clicked.effects.download === "retained" || clicked.effects.download === "not_observed",
      `model download saving is on; the effect must never be canceled (got ${clicked.effects.download})`,
    );
    let reportedHandle: string | undefined;
    if (clicked.effects.download === "retained") {
      assert.ok(Array.isArray(clicked.effects.retainedDownloadHandles) && clicked.effects.retainedDownloadHandles.length === 1);
      reportedHandle = clicked.effects.retainedDownloadHandles[0]!;
    } else {
      // not_observed: the effect report carries no handles for what it did not see.
      assert.equal(clicked.effects.retainedDownloadHandles, undefined);
    }
    // Independent of the click's bounded window: bounded-wait for the actual
    // exactly-one retained download under the live capability.
    const listing = await observeRetainedDownloads(f.manager, f.opened.session, f.opened.tab, 1);
    assert.equal(listing.downloads[0]!.suggestedFilename, "live-report.bin");
    if (reportedHandle !== undefined) {
      // The effect-reported handle is the same retained download.
      assert.equal(listing.downloads[0]!.handle, reportedHandle);
    }
    let savePrompt: { title: string; message: string } | undefined;
    const saved = await f.manager.saveDownload(f.opened.session, f.opened.tab, listing.downloads[0]!.handle, "saved/live-report.bin", async (request) => {
      savePrompt = request;
      return true;
    });
    assert.equal(saved.operation, "download_save");
    assert.equal(saved.approval, "human");
    assert.equal(saved.savedBytes, f.LIVE_REPORT_BYTES.length);
    const savedFile = path.join(f.workspaceRoot, "saved", "live-report.bin");
    assert.equal(saved.savedDestination, await realpath(savedFile));
    assert.deepEqual(await readFile(savedFile), f.LIVE_REPORT_BYTES);
    assert.match(savePrompt!.message, /Suggested name \(untrusted page data, not used\): live-report\.bin/);
    // The retained handle is single-use and the staged copy is released.
    assert.deepEqual((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads, []);
  } finally { await f.close(); }
});

test("live browser: a download that lands after the click's bounded window is still retained and savable", async () => {
  const f = await fixture();
  try {
    const config = normalizeConfig({});
    f.manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelDownloadSaving: true });
    // The server deliberately holds this response until the test releases it,
    // so the browser's download event can only arrive after the click returns.
    const clicked = await f.manager.click(f.opened.session, f.opened.tab, await f.ref("Get gated report"), async () => true);
    assert.equal(clicked.effects.download, "not_observed");
    assert.equal(clicked.effects.retainedDownloadHandles, undefined);
    // Nothing is retained yet: the download has not even started.
    assert.deepEqual((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads, []);
    // Release the held response; the independent download observer retains it
    // under the live capability even though the click's window already closed.
    f.releaseGatedFile();
    const listing = await observeRetainedDownloads(f.manager, f.opened.session, f.opened.tab, 1);
    assert.equal(listing.downloads[0]!.suggestedFilename, "gated-report.bin");
    let savePrompt: { title: string; message: string } | undefined;
    const saved = await f.manager.saveDownload(f.opened.session, f.opened.tab, listing.downloads[0]!.handle, "saved/gated-report.bin", async (request) => {
      savePrompt = request;
      return true;
    });
    assert.equal(saved.operation, "download_save");
    assert.equal(saved.approval, "human");
    assert.equal(saved.savedBytes, f.GATED_REPORT_BYTES.length);
    const savedFile = path.join(f.workspaceRoot, "saved", "gated-report.bin");
    assert.equal(saved.savedDestination, await realpath(savedFile));
    assert.deepEqual(await readFile(savedFile), f.GATED_REPORT_BYTES);
    assert.match(savePrompt!.message, /Suggested name \(untrusted page data, not used\): gated-report\.bin/);
    // The retained handle is single-use and the staged copy is released.
    assert.deepEqual((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads, []);
  } finally { await f.close(); }
});

test("live browser: multi-file upload to a single-file input is rejected before dispatch", async () => {
  const f = await fixture();
  try {
    const config = normalizeConfig({});
    f.manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelUploads: true });
    // The fixture input has no `multiple` attribute. Real Playwright rejects
    // two files inside setInputFiles — after approval and with the operation
    // already claimed as started; the manager must refuse it up front.
    const second = path.join(f.workspaceRoot, "live-upload-two.txt");
    await writeFile(second, "second-live-bytes");
    let prompts = 0;
    const before = f.receipts.length;
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await f.ref("Upload"), [f.uploadSource, second], async () => { prompts += 1; return true; }),
      /not_started: the browser file input does not accept multiple files/,
    );
    assert.equal(prompts, 0, "an impossible upload is not an approval question");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.receipts.length, before, "nothing was sent");
    // Nothing dispatched: the session survives and still serves a valid
    // single-file upload.
    const uploaded = await f.manager.upload(f.opened.session, f.opened.tab, await f.ref("Upload"), [f.uploadSource], async () => true);
    assert.equal(uploaded.uploadedFiles, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(f.receipts.length, before + 1);
  } finally { await f.close(); }
});
