import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

const LIVE_REPORT_BYTES = Buffer.from("live-download-bytes-0123456789-abcdef");

interface UploadReceipt { filename: string | null; bodyLength: number; body: Buffer; }

async function fixture() {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-live-"));
  const uploadSource = path.join(workspaceRoot, "live-upload.txt");
  const uploadBytes = Buffer.from("live-upload-bytes-9876543210-fedcba");
  await writeFile(uploadSource, uploadBytes);
  const receipts: UploadReceipt[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>File transfer fixture</title>
        <form action="/upload" method="post" enctype="multipart/form-data">
          <input type="file" name="file" aria-label="Upload">
        </form>
        <a href="/file" download aria-label="Get report">Report</a>
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
    manager, browser, opened, origin, receipts, uploadSource, uploadBytes, workspaceRoot, LIVE_REPORT_BYTES,
    async ref(label: string) {
      const snapshot = await manager.snapshot(opened.session, opened.tab, 10_000);
      const line = snapshot.snapshot.split("\n").find((line) => line.includes(`"${label}"`) && line.includes("[ref="));
      const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
      assert.ok(ref, snapshot.snapshot);
      return ref;
    },
    async close() {
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
    const before = f.receipts.length;
    const clicked = await f.manager.click(f.opened.session, f.opened.tab, await f.ref("Get report"), async () => true);
    assert.equal(clicked.effects.download, "canceled");
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
    assert.equal(clicked.effects.download, "retained");
    assert.ok(Array.isArray(clicked.effects.retainedDownloadHandles) && clicked.effects.retainedDownloadHandles.length === 1);
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 1);
    assert.equal(listing.downloads[0]!.suggestedFilename, "live-report.bin");
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
