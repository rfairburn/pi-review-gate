import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { BrowserInteractionApproval, WebBrowserPermissions } from "../src/config";
import { DEFAULT_BROWSER_PERMISSIONS, normalizeConfig } from "../src/config";
import { FakePage, managerFixture } from "./browser-fakes";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(body: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { body(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(5);
    }
  }
}

interface FakeDownloadOptions {
  filename?: string;
  url?: string;
  content?: Buffer;
  /** Milliseconds before failure() settles; 0 means the next tick. */
  failAfterMs?: number;
  /** Non-null when the download fails (e.g. "net::ERR_ABORTED"). */
  failure?: string | null;
}

let stagedSerial = 0;
function makeFakeDownload(options: FakeDownloadOptions, dir: string) {
  const stagedPath = path.join(dir, `staged-${++stagedSerial}`);
  void writeFile(stagedPath, options.content ?? Buffer.from("private-staged-bytes-42"));
  let canceled = false;
  let deleted = false;
  return {
    stagedPath,
    get canceled() { return canceled; },
    get deleted() { return deleted; },
    suggestedFilename: () => options.filename ?? "report.pdf",
    url: () => options.url ?? "https://example.com/report.pdf",
    failure: () => new Promise<string | null>((resolve) => setTimeout(() => resolve(options.failure ?? null), options.failAfterMs ?? 0)),
    path: async () => stagedPath,
    cancel: async () => { canceled = true; },
    delete: async () => { deleted = true; },
  };
}

async function fileTransferFixture(options: { permissions?: Partial<WebBrowserPermissions>; approval?: BrowserInteractionApproval; retention?: number } = {}) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-"));
  const fixture = managerFixture({ workspaceRoot });
  const config = normalizeConfig({});
  fixture.manager.updateConfig(
    config.web!.fetch,
    options.approval ?? "ask",
    15,
    { ...DEFAULT_BROWSER_PERMISSIONS, ...options.permissions },
    false,
    options.retention ?? config.web!.browserDownloadRetention,
  );
  const opened = await fixture.manager.open("https://example.com/transfer");
  return {
    ...fixture,
    workspaceRoot,
    opened,
    async close() {
      await fixture.manager.shutdown();
      await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

function fileInputTarget(page: FakePage): void {
  page.targetStructure = { ...page.targetStructure, tagName: "input", role: "textbox", href: null, inputType: "file" };
}

async function refOf(fixture: Awaited<ReturnType<typeof fileTransferFixture>>): Promise<string> {
  const snapshot = await fixture.manager.snapshot(fixture.opened.session, fixture.opened.tab, 2_000);
  const ref = snapshot.snapshot.match(/\[ref=([^\]]+)\]/)?.[1];
  assert.ok(ref, snapshot.snapshot);
  return ref;
}

// ---------------------------------------------------------------------------
// BrowserUpload
// ---------------------------------------------------------------------------

test("model uploads are denied before any prompt while the capability is off", async () => {
  const f = await fileTransferFixture();
  const page = f.browser.context.page;
  try {
    fileInputTarget(page);
    const source = path.join(f.workspaceRoot, "upload.txt");
    await writeFile(source, "secret-upload-content-1");
    let prompts = 0;
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [source], async () => { prompts += 1; return true; }),
      /not_started: model file uploads are disabled by the managed-browser permissions; no file was read or sent\./,
    );
    assert.equal(prompts, 0, "a disabled capability is not an approval question");
    assert.equal(page.setInputFilesCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(await f.manager.snapshot(f.opened.session, f.opened.tab, 1_000)), /secret-upload-content-1/);
  } finally { await f.close(); }
});

test("BrowserUpload asks, binds exact sources, dispatches once, and reports metadata only", async () => {
  const f = await fileTransferFixture({ permissions: { modelUploads: true } });
  const page = f.browser.context.page;
  try {
    fileInputTarget(page);
    // Two files require a multiple-file input; real Chromium enforces the same.
    page.targetStructure = { ...page.targetStructure, multiple: true };
    const a = path.join(f.workspaceRoot, "a.txt");
    const b = path.join(f.workspaceRoot, "nested", "b.bin");
    await mkdir(path.dirname(b), { recursive: true });
    await writeFile(a, "alpha-content-123");
    await writeFile(b, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    const ref = await refOf(f);
    let prompt: { title: string; message: string } | undefined;
    const result = await f.manager.upload(f.opened.session, f.opened.tab, ref, [a, b], async (request) => {
      prompt = request;
      return true;
    });
    assert.equal(result.operation, "upload");
    assert.equal(result.consequence, "file_upload");
    assert.equal(result.approval, "human");
    assert.equal(result.confirmed, true);
    assert.equal(result.effect, "completed");
    assert.equal(result.uploadedFiles, 2);
    assert.equal(result.uploadedBytes, 17 + 8);
    assert.equal(result.effects.download, "not_observed");
    assert.deepEqual(page.setInputFilesCalls.length, 1);
    assert.deepEqual(page.setInputFilesCalls[0]!.paths, [await realpath(a), await realpath(b)]);
    assert.ok(prompt, "the exact upload was confirmed interactively");
    assert.equal(prompt!.title, "Confirm model file upload");
    assert.match(prompt!.message, /2 local file\(s\)/);
    assert.match(prompt!.message, /example\.com/);
    assert.doesNotMatch(prompt!.message, /alpha-content-123/, "file content never reaches the prompt");
    const rendered = JSON.stringify(result);
    assert.doesNotMatch(rendered, /alpha-content-123|private-staged/);
  } finally { await f.close(); }
});

test("BrowserUpload resolves relative sources against the session working directory", async () => {
  const f = await fileTransferFixture({ permissions: { modelUploads: true }, approval: "automatically-accept" });
  const page = f.browser.context.page;
  try {
    fileInputTarget(page);
    await writeFile(path.join(f.workspaceRoot, "relative.txt"), "relative-content");
    const result = await f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), ["relative.txt"]);
    assert.equal(result.uploadedFiles, 1);
    assert.deepEqual(page.setInputFilesCalls[0]!.paths, [path.join(await realpath(f.workspaceRoot), "relative.txt")]);
  } finally { await f.close(); }
});

test("BrowserUpload denial and unavailable UI never dispatch", async () => {
  const denied = await fileTransferFixture({ permissions: { modelUploads: true } });
  const deniedPage = denied.browser.context.page;
  try {
    fileInputTarget(deniedPage);
    const source = path.join(denied.workspaceRoot, "denied.txt");
    await writeFile(source, "x");
    await assert.rejects(
      denied.manager.upload(denied.opened.session, denied.opened.tab, await refOf(denied), [source], async () => false),
      /not_started: interactive confirmation was denied\./,
    );
    assert.equal(deniedPage.setInputFilesCalls.length, 0);
  } finally { await denied.close(); }

  const noUi = await fileTransferFixture({ permissions: { modelUploads: true } });
  const noUiPage = noUi.browser.context.page;
  try {
    fileInputTarget(noUiPage);
    const source = path.join(noUi.workspaceRoot, "noui.txt");
    await writeFile(source, "x");
    await assert.rejects(
      noUi.manager.upload(noUi.opened.session, noUi.opened.tab, await refOf(noUi), [source]),
      /requires an interactive Pi confirmation/,
    );
    assert.equal(noUiPage.setInputFilesCalls.length, 0);
  } finally { await noUi.close(); }
});

test("BrowserUpload honors automatically-accept and automatically-deny without prompting", async () => {
  const accept = await fileTransferFixture({ permissions: { modelUploads: true }, approval: "automatically-accept" });
  try {
    fileInputTarget(accept.browser.context.page);
    const source = path.join(accept.workspaceRoot, "auto.txt");
    await writeFile(source, "auto-content");
    let prompts = 0;
    const result = await accept.manager.upload(accept.opened.session, accept.opened.tab, await refOf(accept), [source], async () => { prompts += 1; return true; });
    assert.equal(result.approval, "automatic");
    assert.equal(prompts, 0);
    assert.equal(accept.browser.context.page.setInputFilesCalls.length, 1);
  } finally { await accept.close(); }

  const deny = await fileTransferFixture({ permissions: { modelUploads: true }, approval: "automatically-deny" });
  try {
    fileInputTarget(deny.browser.context.page);
    const source = path.join(deny.workspaceRoot, "auto-denied.txt");
    await writeFile(source, "x");
    await assert.rejects(
      deny.manager.upload(deny.opened.session, deny.opened.tab, await refOf(deny), [source]),
      /automatically denied this approval-required action/,
    );
    assert.equal(deny.browser.context.page.setInputFilesCalls.length, 0);
  } finally { await deny.close(); }
});

test("YOLO overrides a stored automatically-deny policy for model uploads", async () => {
  const f = await fileTransferFixture({ permissions: { yolo: true }, approval: "automatically-deny" });
  try {
    fileInputTarget(f.browser.context.page);
    const source = path.join(f.workspaceRoot, "yolo.txt");
    await writeFile(source, "yolo-content");
    let prompts = 0;
    const result = await f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [source], async () => { prompts += 1; return true; });
    assert.equal(result.approval, "automatic", "YOLO approvals are policy approvals, never human");
    assert.equal(prompts, 0);
    assert.equal(f.browser.context.page.setInputFilesCalls.length, 1);
  } finally { await f.close(); }
});

test("revoking model uploads during the approval prompt kills the pending permit", async () => {
  const f = await fileTransferFixture({ permissions: { modelUploads: true } });
  const page = f.browser.context.page;
  try {
    fileInputTarget(page);
    const source = path.join(f.workspaceRoot, "revoked.txt");
    await writeFile(source, "x");
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [source], async () => {
        // Settings change while the human is deciding: the stored permission
        // must not stay in force for the pending permit.
        f.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, DEFAULT_BROWSER_PERMISSIONS);
        return true;
      }),
      /not_started: model file uploads are disabled by the managed-browser permissions/,
    );
    assert.equal(page.setInputFilesCalls.length, 0);
  } finally { await f.close(); }
});

test("BrowserUpload revalidates the approved target and sources before dispatch", async () => {
  const staleTarget = await fileTransferFixture({ permissions: { modelUploads: true } });
  try {
    fileInputTarget(staleTarget.browser.context.page);
    const source = path.join(staleTarget.workspaceRoot, "stale-target.txt");
    await writeFile(source, "x");
    await assert.rejects(
      staleTarget.manager.upload(staleTarget.opened.session, staleTarget.opened.tab, await refOf(staleTarget), [source], async () => {
        // The control changed after the human approved this exact target.
        staleTarget.browser.context.page.targetStructure = { ...staleTarget.browser.context.page.targetStructure, multiple: true };
        return true;
      }),
      /not_started: the approved target or source files changed/,
    );
    assert.equal(staleTarget.browser.context.page.setInputFilesCalls.length, 0);
  } finally { await staleTarget.close(); }

  const changedSource = await fileTransferFixture({ permissions: { modelUploads: true } });
  try {
    fileInputTarget(changedSource.browser.context.page);
    const source = path.join(changedSource.workspaceRoot, "changed.txt");
    await writeFile(source, "original-size-16");
    await assert.rejects(
      changedSource.manager.upload(changedSource.opened.session, changedSource.opened.tab, await refOf(changedSource), [source], async () => {
        await writeFile(source, "replaced-with-different-content-after-approval");
        return true;
      }),
      /not_started: Browser upload source changed after approval; nothing was uploaded\./,
    );
    assert.equal(changedSource.browser.context.page.setInputFilesCalls.length, 0);
  } finally { await changedSource.close(); }
});

test("BrowserUpload rejects non-file targets and invalid source lists", async () => {
  const f = await fileTransferFixture({ permissions: { modelUploads: true }, approval: "automatically-accept" });
  const page = f.browser.context.page;
  try {
    page.targetStructure = { ...page.targetStructure, tagName: "input", role: "textbox", href: null, inputType: "text" };
    const textTargetSource = path.join(f.workspaceRoot, "text-target.txt");
    await writeFile(textTargetSource, "x");
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [textTargetSource]),
      /not a file input control/,
    );
    const files: string[] = [];
    for (let index = 0; index < 33; index += 1) {
      const file = path.join(f.workspaceRoot, `many-${index}.txt`);
      await writeFile(file, "x");
      files.push(file);
    }
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), files),
      /exceeds its bounded size/,
    );
    const directory = path.join(f.workspaceRoot, "a-directory");
    await mkdir(directory);
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [directory]),
      /not a regular file/,
    );
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [path.join(f.workspaceRoot, "missing.txt")]),
      /does not exist or cannot be resolved/,
    );
    assert.equal(page.setInputFilesCalls.length, 0);
  } finally { await f.close(); }
});

test("BrowserUpload rejects multi-file requests against a single-file input before any prompt", async () => {
  const f = await fileTransferFixture({ permissions: { modelUploads: true } });
  const page = f.browser.context.page;
  try {
    // No `multiple` attribute: Playwright would reject two files inside
    // setInputFiles, after approval and with the operation already claimed as
    // started. The manager must refuse it up front instead.
    fileInputTarget(page);
    const a = path.join(f.workspaceRoot, "one.txt");
    const b = path.join(f.workspaceRoot, "two.txt");
    await writeFile(a, "1");
    await writeFile(b, "2");
    let prompts = 0;
    await assert.rejects(
      f.manager.upload(f.opened.session, f.opened.tab, await refOf(f), [a, b], async () => { prompts += 1; return true; }),
      /not_started: the browser file input does not accept multiple files/,
    );
    assert.equal(prompts, 0, "an impossible upload is not an approval question");
    assert.equal(page.setInputFilesCalls.length, 0);
    // Nothing dispatched, so the session must survive (no teardown).
    const snapshot = await f.manager.snapshot(f.opened.session, f.opened.tab, 1_000);
    assert.ok(snapshot.snapshot.length > 0);
  } finally { await f.close(); }
});

// ---------------------------------------------------------------------------
// BrowserDownloadSave: retention and listing
// ---------------------------------------------------------------------------

test("downloads are canceled and never retained while model download saving is off", async () => {
  const f = await fileTransferFixture();
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await until(() => assert.equal(download.canceled, true));
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.deepEqual(listing.downloads, []);
  } finally { await f.close(); }
});

test("retained pending downloads are listed with bounded metadata only", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({ content: Buffer.from("listing-bytes-987") }, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 1);
    assert.equal(listing.downloads[0]!.suggestedFilename, "report.pdf");
    assert.equal(listing.downloads[0]!.state, "completed");
    assert.match(String(listing.downloads[0]!.url), /example\.com/);
    assert.doesNotMatch(JSON.stringify(listing), /listing-bytes-987/, "bytes never enter the listing");
  } finally { await f.close(); }
});

test("failed downloads are retained as failed and cannot be saved", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({ failure: "net::ERR_ABORTED" }, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads[0]!.state, "failed");
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, f.opened.tab, listing.downloads[0]!.handle, "out.pdf", async () => true),
      /not_started: the retained download is failed; nothing was written\./,
    );
  } finally { await f.close(); }
});

test("the retention cap evicts and cancels the oldest pending download", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const first = makeFakeDownload({ filename: "oldest.pdf" }, f.workspaceRoot);
    page.emit("download", first as never);
    for (let index = 1; index < 9; index += 1) {
      page.emit("download", makeFakeDownload({ filename: `n${index}.pdf` }, f.workspaceRoot) as never);
    }
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 8);
    await until(() => assert.equal(first.canceled, true));
    const after = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(after.downloads.length, 8);
    assert.ok(after.downloads.every((entry) => entry.suggestedFilename !== "oldest.pdf"), "the oldest retained download was evicted");
  } finally { await f.close(); }
});

test("the configured retention cap evicts and cancels the oldest pending download", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true }, retention: 2 });
  const page = f.browser.context.page;
  try {
    const first = makeFakeDownload({ filename: "oldest.pdf" }, f.workspaceRoot);
    page.emit("download", first as never);
    for (let index = 1; index < 3; index += 1) {
      page.emit("download", makeFakeDownload({ filename: `n${index}.pdf` }, f.workspaceRoot) as never);
    }
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 2, "the configured threshold, not the default, bounds retention");
    await until(() => assert.equal(first.canceled, true));
    const after = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.ok(after.downloads.every((entry) => entry.suggestedFilename !== "oldest.pdf"), "the oldest retained download was evicted");
  } finally { await f.close(); }
});

test("retention 0 disables count-based eviction entirely", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true }, retention: 0 });
  const page = f.browser.context.page;
  try {
    const downloads = [];
    for (let index = 0; index < 10; index += 1) {
      const download = makeFakeDownload({ filename: `unlimited-${index}.pdf` }, f.workspaceRoot);
      page.emit("download", download as never);
      downloads.push(download);
    }
    await delay(20);
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 10, "more than the default cap of 8 stays retained under 0");
    for (const download of downloads) {
      assert.equal(download.canceled, false, "no count-based eviction cancels pending downloads");
      assert.equal(download.deleted, false);
    }
  } finally { await f.close(); }
});

test("a live retention lowering applies at the next download arrival without deleting pending downloads", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const retained = [];
    for (let index = 0; index < 3; index += 1) {
      const download = makeFakeDownload({ filename: `pre-${index}.pdf` }, f.workspaceRoot);
      page.emit("download", download as never);
      retained.push(download);
    }
    await delay(20);
    assert.equal((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads.length, 3);
    // Lowering the cap alone never deletes pending downloads.
    const config = normalizeConfig({ web: { browserDownloadRetention: 2 } });
    f.manager.updateConfig(config.web!.fetch, "ask", 15, { ...DEFAULT_BROWSER_PERMISSIONS, modelDownloadSaving: true }, false, 2);
    assert.equal((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads.length, 3, "editing the setting never deletes pending downloads");
    for (const download of retained) assert.equal(download.canceled || download.deleted, false);
    // The next arrival enforces the lowered cap.
    page.emit("download", makeFakeDownload({ filename: "post.pdf" }, f.workspaceRoot) as never);
    await delay(20);
    const after = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads;
    assert.equal(after.length, 2);
    assert.ok(after.every((entry) => !["pre-0.pdf", "pre-1.pdf"].includes(entry.suggestedFilename)), "the oldest were evicted at the next arrival");
  } finally { await f.close(); }
});

// ---------------------------------------------------------------------------
// BrowserDownloadSave: saving
// ---------------------------------------------------------------------------

test("BrowserDownloadSave asks, writes the staged artifact, and releases it", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const content = Buffer.from("saved-download-bytes-1234567890");
    const download = makeFakeDownload({ content }, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    const handle = listing.downloads[0]!.handle;
    let prompt: { title: string; message: string } | undefined;
    const result = await f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "downloads/report.pdf", async (request) => {
      prompt = request;
      return true;
    });
    assert.equal(result.operation, "download_save");
    assert.equal(result.consequence, "file_download_save");
    assert.equal(result.approval, "human");
    assert.equal(result.savedBytes, content.length);
    const expected = path.join(await realpath(f.workspaceRoot), "downloads", "report.pdf");
    assert.equal(result.savedDestination, expected);
    assert.deepEqual(await readFile(expected), content);
    assert.ok(prompt!.title === "Confirm model download saving");
    assert.match(prompt!.message, /will be created at the destination/);
    assert.match(prompt!.message, /Suggested name \(untrusted page data, not used\): report\.pdf/);
    assert.doesNotMatch(prompt!.message, /saved-download-bytes-1234567890/, "bytes never reach the prompt");
    // The saved artifact is released: no duplicate staged bytes remain and the
    // handle is single-use.
    await until(() => assert.equal(download.deleted, true));
    const after = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.deepEqual(after.downloads, []);
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "again.pdf", async () => true),
      /not_started: invalid or stale owned download capability/,
    );
  } finally { await f.close(); }
});

test("BrowserDownloadSave denial leaves the retained download and writes nothing", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "denied.pdf", async () => false),
      /not_started: interactive confirmation was denied\./,
    );
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 1, "a denied save keeps the download available");
    assert.equal(listing.downloads[0]!.handle, handle);
    assert.equal(download.canceled, false);
    assert.equal(download.deleted, false);
  } finally { await f.close(); }
});

test("BrowserDownloadSave honors automatically-accept and YOLO over a stored deny", async () => {
  const accept = await fileTransferFixture({ permissions: { modelDownloadSaving: true }, approval: "automatically-accept" });
  try {
    const download = makeFakeDownload({}, accept.workspaceRoot);
    accept.browser.context.page.emit("download", download as never);
    await delay(20);
    const handle = (await accept.manager.listDownloads(accept.opened.session, accept.opened.tab)).downloads[0]!.handle;
    let prompts = 0;
    const result = await accept.manager.saveDownload(accept.opened.session, accept.opened.tab, handle, "auto.pdf", async () => { prompts += 1; return true; });
    assert.equal(result.approval, "automatic");
    assert.equal(prompts, 0);
  } finally { await accept.close(); }

  const yolo = await fileTransferFixture({ permissions: { yolo: true }, approval: "automatically-deny" });
  try {
    const download = makeFakeDownload({}, yolo.workspaceRoot);
    yolo.browser.context.page.emit("download", download as never);
    await delay(20);
    const handle = (await yolo.manager.listDownloads(yolo.opened.session, yolo.opened.tab)).downloads[0]!.handle;
    const result = await yolo.manager.saveDownload(yolo.opened.session, yolo.opened.tab, handle, "yolo.pdf");
    assert.equal(result.approval, "automatic");
  } finally { await yolo.close(); }
});

test("revoking model download saving during approval cancels the save and the retention", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "revoked.pdf", async () => {
        f.manager.updateConfig(normalizeConfig({}).web!.fetch, "ask", 15, DEFAULT_BROWSER_PERMISSIONS);
        return true;
      }),
      /not_started: model download saving is disabled by the managed-browser permissions/,
    );
    assert.equal(download.canceled || download.deleted, true, "the retained artifact was released");
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.deepEqual(listing.downloads, []);
  } finally { await f.close(); }
});

// Root bypasses filesystem permission bits, so the honest-refusal regression
// cannot be exercised deterministically there.
const isRunningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

test("outside-workspace destinations are eligible under the existing model write authority", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true }, approval: "automatically-accept" });
  const page = f.browser.context.page;
  try {
    const content = Buffer.from("outside-workspace-bytes-123");
    page.emit("download", makeFakeDownload({ content }, f.workspaceRoot) as never);
    page.emit("download", makeFakeDownload({ content }, f.workspaceRoot) as never);
    await delay(20);
    const [first, second] = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads;
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-outside-"));
    try {
      // An absolute path outside the workspace is saved exactly where the
      // model's existing host write authority reaches it.
      const destination = path.join(outsideDir, "outside.pdf");
      const result = await f.manager.saveDownload(f.opened.session, f.opened.tab, first!.handle, destination);
      assert.equal(result.savedDestination, path.join(await realpath(outsideDir), "outside.pdf"));
      assert.deepEqual(await readFile(destination), content);
      // A relative path resolves deterministically against the session working
      // directory — including a relative escape out of it.
      const relativeEscape = path.relative(f.workspaceRoot, path.join(outsideDir, "rel-escape.pdf"));
      assert.ok(relativeEscape.startsWith(".."), relativeEscape);
      const escaped = await f.manager.saveDownload(f.opened.session, f.opened.tab, second!.handle, relativeEscape);
      assert.equal(escaped.savedDestination, path.join(await realpath(outsideDir), "rel-escape.pdf"));
      assert.deepEqual(await readFile(path.join(outsideDir, "rel-escape.pdf")), content);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test("Ask prompts with the exact outside-workspace path; denial and cancel write nothing", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-ask-"));
    try {
      const expectedReal = path.join(await realpath(outsideDir), "ask.pdf");
      // Accept: the prompt names the exact real destination outside the
      // workspace, and the save lands there.
      page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
      await delay(20);
      let prompt: { title: string; message: string } | undefined;
      const result = await f.manager.saveDownload(f.opened.session, f.opened.tab,
        (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle,
        path.join(outsideDir, "ask.pdf"), async (request) => { prompt = request; return true; });
      assert.equal(result.savedDestination, expectedReal);
      assert.ok(prompt!.message.includes(expectedReal), "the approval binds the exact real destination");
      // Denial: nothing is written and the download stays retained. The
      // successful save above released its handle, so this is index 0.
      page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
      await delay(20);
      let listing = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads;
      const deniedHandle = listing[0]!.handle;
      await assert.rejects(
        f.manager.saveDownload(f.opened.session, f.opened.tab, deniedHandle, path.join(outsideDir, "denied.pdf"), async () => false),
        /not_started: interactive confirmation was denied\./,
      );
      // Cancel: an unavailable or cancelled prompt is not an approval.
      page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
      await delay(20);
      listing = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads;
      const cancelledHandle = listing[1]!.handle;
      await assert.rejects(
        f.manager.saveDownload(f.opened.session, f.opened.tab, cancelledHandle, path.join(outsideDir, "cancelled.pdf"),
          async () => { throw new Error("user cancelled"); }),
        /not_started: interaction approval was unavailable or cancelled\./,
      );
      assert.deepEqual(await readdir(outsideDir), ["ask.pdf"], "denial and cancel wrote nothing");
      const after = await f.manager.listDownloads(f.opened.session, f.opened.tab);
      assert.equal(after.downloads.length, 2, "denied and cancelled saves keep the downloads retained");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test("Automatically Deny rejects an outside-workspace save before dispatch", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true }, approval: "automatically-deny" });
  const page = f.browser.context.page;
  try {
    page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-deny-"));
    try {
      let prompts = 0;
      await assert.rejects(
        f.manager.saveDownload(f.opened.session, f.opened.tab, handle, path.join(outsideDir, "denied.pdf"),
          async () => { prompts += 1; return true; }),
        /automatically denied this approval-required action/,
      );
      assert.equal(prompts, 0, "the policy denial happens before any prompt");
      assert.deepEqual(await readdir(outsideDir), [], "nothing was written");
      assert.equal((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads.length, 1, "the download stays retained");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test("YOLO overrides a stored deny, but a host write refusal stays honest", {
  skip: isRunningAsRoot ? "root bypasses filesystem permission bits" : false,
}, async () => {
  const f = await fileTransferFixture({ permissions: { yolo: true }, approval: "automatically-deny" });
  const page = f.browser.context.page;
  try {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-yolo-"));
    try {
      const readonlyDir = path.join(outsideDir, "readonly");
      await mkdir(readonlyDir);
      await chmod(readonlyDir, 0o555);
      try {
        page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
        await delay(20);
        const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
        let prompts = 0;
        // YOLO turns the stored Automatically Deny into an automatic approval,
        // but the host filesystem still refuses the non-writable destination:
        // the refusal must surface with its OS error, not a generic failure.
        await assert.rejects(
          f.manager.saveDownload(f.opened.session, f.opened.tab, handle, path.join(readonlyDir, "denied.pdf"),
            async () => { prompts += 1; return true; }),
          (error: Error) => /not_started/.test(error.message) && /(EACCES|permission denied)/.test(error.message),
        );
        assert.equal(prompts, 0, "YOLO approval is automatic; the refusal comes from the host filesystem");
        assert.deepEqual(await readdir(readonlyDir), [], "nothing was written");
        assert.equal((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads.length, 1, "the retained download survives a refused save");
      } finally {
        await chmod(readonlyDir, 0o755);
      }
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test("a symlinked destination is approved and saved at its real location", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-symlink-"));
    try {
      const link = path.join(f.workspaceRoot, "friendly-link");
      await symlink(outsideDir, link);
      page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
      await delay(20);
      const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
      const expectedReal = path.join(await realpath(outsideDir), "through-link.pdf");
      let prompt: { title: string; message: string } | undefined;
      const result = await f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "friendly-link/through-link.pdf", async (request) => {
        prompt = request;
        return true;
      });
      assert.equal(result.savedDestination, expectedReal);
      assert.ok(prompt!.message.includes(expectedReal), "the approval binds the real location behind the symlink");
      assert.doesNotMatch(prompt!.message, /friendly-link/, "the raw lexical path never reaches the prompt");
      assert.deepEqual(await readdir(outsideDir), ["through-link.pdf"]);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test("an existing directory is not a file destination", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    page.emit("download", makeFakeDownload({}, f.workspaceRoot) as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    const subdir = path.join(f.workspaceRoot, "subdir");
    await mkdir(subdir);
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "subdir", async () => true),
      /existing directory/,
    );
    assert.equal((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads.length, 1, "a rejected save keeps the download retained");
  } finally { await f.close(); }
});

test("an approved overwrite replaces the existing destination file", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const content = Buffer.from("replacement-bytes-7654321");
    const download = makeFakeDownload({ content }, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    const destination = path.join(f.workspaceRoot, "existing.pdf");
    await writeFile(destination, "old-content");
    let prompt: { title: string; message: string } | undefined;
    const result = await f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "existing.pdf", async (request) => {
      prompt = request;
      return true;
    });
    assert.equal(result.savedBytes, content.length);
    assert.deepEqual(await readFile(destination), content);
    assert.match(prompt!.message, /already exists and will be replaced/);
  } finally { await f.close(); }
});

test("BrowserDownloadSave rejects a new-file destination created after approval", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    const destination = path.join(f.workspaceRoot, "race-new.pdf");
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "race-new.pdf", async () => {
        // A file appears at the approved new-file destination while the human
        // is deciding: the existed fact flipped, so nothing may be written.
        await writeFile(destination, "created-while-approving");
        return true;
      }),
      /not_started: the approved destination changed after approval/,
    );
    assert.equal(await readFile(destination, "utf8"), "created-while-approving", "the pre-existing file is untouched");
    const listing = await f.manager.listDownloads(f.opened.session, f.opened.tab);
    assert.equal(listing.downloads.length, 1, "a rejected save keeps the download retained");
  } finally { await f.close(); }
});

test("BrowserDownloadSave rejects a destination swapped for a symlink after approval", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    const destination = path.join(f.workspaceRoot, "swapped.pdf");
    await writeFile(destination, "old-content");
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "browser-file-transfer-swap-"));
    try {
      await assert.rejects(
        f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "swapped.pdf", async () => {
          // The approved regular file is replaced by a symlink pointing outside
          // the workspace while the human is deciding: the real path no longer
          // matches the approval and nothing may be written.
          await rm(destination);
          await symlink(outsideDir, destination);
          return true;
        }),
        /not_started/,
      );
      assert.deepEqual(await readdir(outsideDir), [], "no bytes reached the symlink target");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  } finally { await f.close(); }
});

test("saving waits for an in-progress download to complete before prompting", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const content = Buffer.from("late-completion-bytes");
    const download = makeFakeDownload({ content, failAfterMs: 80 }, f.workspaceRoot);
    page.emit("download", download as never);
    let prompted = false;
    const result = await f.manager.saveDownload(f.opened.session, f.opened.tab,
      (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle, "late.pdf", async () => {
        // The prompt must only appear once the artifact is complete.
        prompted = true;
        return true;
      });
    assert.equal(prompted, true);
    assert.equal(result.savedBytes, content.length);
    await until(() => assert.equal(download.deleted, true));
  } finally { await f.close(); }
});

test("download handles are scoped to the retaining session and tab", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const handle = (await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads[0]!.handle;
    const second = await f.manager.tabs(f.opened.session, "open", undefined, "https://example.com/other");
    assert.ok(second.activeTab);
    assert.notEqual(second.activeTab, f.opened.tab);
    // The other tab sees no downloads and cannot save this one.
    assert.deepEqual((await f.manager.listDownloads(f.opened.session, second.activeTab)).downloads, []);
    await assert.rejects(
      f.manager.saveDownload(f.opened.session, second.activeTab, handle, "cross-tab.pdf", async () => true),
      /not_started: invalid or stale owned download capability/,
    );
    // The owning tab still saves it.
    const result = await f.manager.saveDownload(f.opened.session, f.opened.tab, handle, "own-tab.pdf", async () => true);
    assert.equal(result.savedBytes, Buffer.from("private-staged-bytes-42").length);
  } finally { await f.close(); }
});

test("closing the session releases retained pending downloads", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    assert.equal((await f.manager.listDownloads(f.opened.session, f.opened.tab)).downloads.length, 1);
    await f.manager.close(f.opened.session);
    await until(() => assert.equal(download.deleted || download.canceled, true));
  } finally { await f.close(); }
});

test("closing a tab releases its retained pending downloads", async () => {
  const f = await fileTransferFixture({ permissions: { modelDownloadSaving: true } });
  const page = f.browser.context.page;
  try {
    // Retain one download on the first tab, then open a second tab.
    const download = makeFakeDownload({}, f.workspaceRoot);
    page.emit("download", download as never);
    await delay(20);
    const second = await f.manager.tabs(f.opened.session, "open", undefined, "https://example.com/other");
    assert.ok(second.activeTab);
    // Closing the first tab releases its retained downloads: they become
    // unusable and stop counting against the session retention cap.
    const result = await f.manager.tabs(f.opened.session, "close", f.opened.tab);
    assert.equal(result.sessionClosed, false, "the second tab keeps the session alive");
    await until(() => assert.equal(download.deleted || download.canceled, true));
    assert.deepEqual((await f.manager.listDownloads(f.opened.session, second.activeTab)).downloads, []);
  } finally { await f.close(); }
});

// ---------------------------------------------------------------------------
// Registered tool boundary
// ---------------------------------------------------------------------------

test("registered BrowserUpload and BrowserDownloadSave enforce their parameter contracts", async () => {
  const f = await fileTransferFixture({ permissions: { modelUploads: true, modelDownloadSaving: true } });
  const { WebToolManager } = await import("../src/web/tools");
  const tools = new Map<string, any>();
  const boundary = new WebToolManager({ registerTool: (tool) => tools.set(tool.name, tool) }, normalizeConfig({}), undefined, undefined, f.manager);
  boundary.register();
  try {
    const call = (name: string, params: Record<string, unknown>) =>
      tools.get(name)!.execute("file-transfer", params, new AbortController().signal, undefined, undefined).then(
        (result: any) => result,
        (error: Error) => error,
      );
    const upload = await call("BrowserUpload", { session: f.opened.session, tab: f.opened.tab, ref: "e7" });
    assert.ok(upload instanceof Error);
    assert.match(upload.message, /not_started/);
    const listing = await call("BrowserDownloadSave", { session: f.opened.session, tab: f.opened.tab });
    assert.ok(listing.details, "omitting both download and destination lists pending downloads");
    assert.deepEqual(listing.details.response.downloads, []);
    const half = await call("BrowserDownloadSave", { session: f.opened.session, tab: f.opened.tab, download: "dl1" });
    assert.ok(half instanceof Error);
    assert.match(half.message, /not_started: unsupported or out-of-bounds arguments/);
  } finally {
    await boundary.cleanup();
    await f.close();
  }
});
