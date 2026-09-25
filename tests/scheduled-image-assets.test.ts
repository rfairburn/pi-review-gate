/**
 * Scheduled instruction image assets (issue: scheduled image assets).
 *
 * Two fidelity tiers, mirroring the bridge and workspace-editor tests:
 *
 * - Unit tier (always runs): the Save-time transaction helpers in
 *   src/settings/scheduled-image-assets.ts — provenance-carrying candidate
 *   collection against the FINAL staged instructions (bounded to Pi's own
 *   `pi-clipboard-<UUID>.<ext>` temp image paste naming, so plain clipboard
 *   text stays text), content validation
 *   (magic bytes, regular file, bounded size), the private managed store's
 *   modes and rollback discipline, the fail-closed gate for Pi-native
 *   clipboard temp references without provenance, and the dispatch-side
 *   missing-asset check.
 * - TUI flow tier: the full /review-settings path driven through the same
 *   host-wired native editor bridge and menu seams the workspace tests use —
 *   native image paste observed via onHostInsert, Save copying the pasted
 *   image and persisting the managed path, Cancel and failures leaving the
 *   config and the store untouched.
 */

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ScheduledTaskCatalog } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  assertScheduledImagesPresent,
  collectScheduledImageCandidates,
  findManagedScheduledImagePaths,
  findPiClipboardTempPaths,
  findUnobservedPiClipboardTempPaths,
  isPiClipboardTempPath,
  isPiClipboardTempImagePath,
  isPathShapedInsert,
  managedScheduledImageRoot,
  MAX_SCHEDULED_IMAGE_BYTES,
  prepareScheduledImageAssets,
  readBoundedImage,
  rollbackScheduledImageAssets,
  rollbackScheduledImageAssetsUnlessPersisted,
  ScheduledImageAssetError,
  sniffImageType,
} from "../src/settings/scheduled-image-assets";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import { createFakeMenuTuiHost, KEY_DOWN, KEY_ENTER, KEY_ESCAPE } from "./menu-tui-fakes";
import {
  ENTER,
  ESCAPE,
  createBridgeUi,
  fakeHost,
  fakeKeybindingsManager,
  type FakeBridgeEditor,
} from "./bridge-fakes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 7),
]);

async function writeImage(path: string, bytes: Buffer = PNG_BYTES): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/**
 * A unique GENUINE Pi clipboard temp image path: the exact naming Pi's
 * native image paste produces (`pi-clipboard-<UUID>.<ext>` in the OS temp
 * directory). Random per call, so concurrent suites never collide.
 */
function clipboardTempImage(ext = "png"): string {
  return join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
}

/**
 * Write a unique Pi-shaped temp image file. The test that created it removes
 * it in its own finally — nothing here ever touches preexisting temp paths.
 */
async function writeTempImage(bytes: Buffer = PNG_BYTES): Promise<string> {
  const path = clipboardTempImage();
  await writeImage(path, bytes);
  return path;
}

function entryOf(overrides: Partial<ScheduledTaskCatalog[string]> = {}): ScheduledTaskCatalog[string] {
  return {
    name: "Nightly docs check",
    cron: "30 2 * * *",
    enabled: true,
    kind: "execute",
    instructions: "Check the docs for staleness",
    workspace: "/tmp/prg-nightly",
    ...overrides,
  };
}

async function prepareFixture(): Promise<{ dir: string; configPath: string; root: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-image-"));
  return { dir, configPath: join(dir, "review-gate.json"), root: join(dir, "scheduled-image-assets") };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

test("the store root resolves a relative config path so managed paths stay absolute", () => {
  // The supported PI_REVIEW_GATE_CONFIG=<relative path> spelling must still
  // produce a managed ABSOLUTE path a later run can read from any cwd.
  assert.equal(managedScheduledImageRoot("review-gate.json"), join(process.cwd(), "scheduled-image-assets"));
});

test("a pasted token glued to adjacent text fails Save closed instead of persisting an unusable path", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze${temp}` }),
    };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && /space before and after the pasted path/.test(error.message),
    );
    assert.equal(await exists(root), false, "nothing was copied for a glued reference");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("every occurrence of a pasted token must be isolated, not only the first", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze ${temp} and x${temp}` }),
    };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && /space before and after the pasted path/.test(error.message),
    );
    assert.equal(await exists(root), false, "nothing was copied while any occurrence stays glued");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("text glued after a pasted path fails Save instead of persisting an unresolvable suffix", async () => {
  // A punctuation-glued suffix (for example `.bak`) would survive the
  // exact-token replacement and persist `<managed>.bak`, which no dispatch
  // scan can resolve; trailing sentence punctuation (`.`, `,`) stays legal
  // because the scanners trim it when comparing.
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze ${temp}.bak and report` }),
    };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && error.message.includes(".bak")
        && /glued directly after it/.test(error.message),
    );
    assert.equal(await exists(root), false, "nothing was copied for a glued suffix");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("a __proto__-keyed entry stays an own data key through the transaction and keeps its gate", async () => {
  const { dir, configPath, root } = await prepareFixture();
  try {
    // A config file can carry `__proto__` as an OWN enumerable data key (the
    // id grammar accepts it); plain assignment in the transaction would turn
    // it into a prototype write, drop the entry from the persisted catalog,
    // and make the next Save delete the task from the config file.
    const protoEntry = entryOf({ name: "Prototype id", instructions: "no path here" });
    const normalEntry = entryOf({ name: "Normal", instructions: "no path here either" });
    const catalog: ScheduledTaskCatalog = {};
    Object.defineProperty(catalog, "__proto__", { value: protoEntry, enumerable: true, writable: true, configurable: true });
    Object.defineProperty(catalog, "task-normal", { value: normalEntry, enumerable: true, writable: true, configurable: true });

    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map());
    assert.equal(Object.prototype.hasOwnProperty.call(prepared.catalog, "__proto__"), true, "the id stays an own key");
    const descriptor = Object.getOwnPropertyDescriptor(prepared.catalog, "__proto__")!;
    assert.equal(descriptor.enumerable, true, "the id stays enumerable");
    assert.deepEqual(descriptor.value, protoEntry, "the entry is the data value, not a prototype write");
    assert.equal(Object.prototype.hasOwnProperty.call(prepared.catalog, "task-normal"), true, "other entries are untouched");
    // The gate still sees the prototype-keyed entry: an unobserved temp
    // reference in it fails the Save exactly like any other entry.
    const unobservedTemp = clipboardTempImage();
    const gatedCatalog: ScheduledTaskCatalog = {};
    Object.defineProperty(gatedCatalog, "__proto__", {
      value: entryOf({ name: "Prototype id", instructions: `Analyze ${unobservedTemp}` }),
      enumerable: true, writable: true, configurable: true,
    });
    await assert.rejects(
      prepareScheduledImageAssets(configPath, gatedCatalog, new Map()),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && error.message.includes(unobservedTemp)
        && /provenance cannot be verified/.test(error.message),
    );
    assert.equal(await exists(root), false, "nothing was copied for the gated entry");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("rollback keeps created copies the persisted config references, removes the rest", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze ${temp}` }),
      "task-beta": entryOf({ name: "Also pasted", instructions: `Analyze ${temp}` }),
    };
    const provenance = new Map([
      ["task-alpha", [temp]],
      ["task-beta", [temp]],
    ]);
    const prepared = await prepareScheduledImageAssets(configPath, catalog, provenance);
    const kept = prepared.catalog["task-alpha"]!.instructions.replace("Analyze ", "");
    const removed = prepared.catalog["task-beta"]!.instructions.replace("Analyze ", "");
    // Simulate a persistence failure whose write already landed with only the
    // task-alpha entry: the referenced copy must survive the rollback.
    await writeFile(configPath, JSON.stringify({
      scheduledTasks: { "task-alpha": { ...catalog["task-alpha"]!, instructions: `Analyze ${kept}` } },
    }));
    await rollbackScheduledImageAssetsUnlessPersisted(configPath, prepared);
    assert.equal(await exists(kept), true, "the referenced copy survives");
    assert.equal(await exists(removed), false, "the unreferenced copy is rolled back");
    assert.equal(await exists(join(root, "task-beta")), false, "the emptied per-task directory is removed");
    assert.equal(await exists(join(root, "task-alpha")), true, "the kept copy's directory survives");

    // An unreadable config keeps everything: a failed read is ambiguous.
    const missingPrepared = { catalog, createdFiles: [kept], createdDirs: [] };
    await rollbackScheduledImageAssetsUnlessPersisted(join(dir, "missing-config.json"), missingPrepared);
    assert.equal(await exists(kept), true, "an unreadable config keeps every created copy");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Provenance-carrying candidate collection
// ---------------------------------------------------------------------------

test("candidates require provenance-carrying path-shaped inserts verbatim in the final instructions", () => {
  const temp = clipboardTempImage();
  const typed = "/work/assets/photo.png";
  const instructions = `Analyze ${temp} and compare with ${typed}.`;
  const observed = [temp, "pasted sentence with spaces", "relative/path.png"];
  assert.deepEqual(collectScheduledImageCandidates(instructions, observed), [temp]);
});

test("an observed plain absolute path is never an image candidate, even when it appears verbatim", () => {
  // Pi's native Ctrl+V inserts ordinary clipboard text through the same
  // seam: a plain absolute path (real, missing, a directory), a sentence, or
  // `@` attachment text is a text paste, not an image paste, and must not be
  // validated, copied, or failed.
  const missing = "/work/report.txt";
  const directory = "/work/assets";
  const sentence = "run /work/assets/photo.png through the checker";
  const attachment = "@report-final.txt";
  const instructions = `Check ${missing} and ${directory} and remember: ${sentence} for ${attachment}`;
  assert.deepEqual(collectScheduledImageCandidates(instructions, [missing, directory, sentence, attachment]), []);
  // Even a REAL image file's path is not a candidate: recognition is bounded
  // to Pi's own temp image naming, not to image content or extension.
  const imageFile = "/work/assets/photo.png";
  assert.deepEqual(collectScheduledImageCandidates(`Check ${imageFile}`, [imageFile]), []);
});

test("a Pi temp-shaped insert with a non-image name or non-UUID name is not a copy candidate", () => {
  const wrongExt = join(tmpdir(), `pi-clipboard-${randomUUID()}.txt`);
  const notUuid = join(tmpdir(), "pi-clipboard-notauuid.png");
  const instructions = `Check ${wrongExt} and ${notUuid}`;
  // Provenance-carrying but not image-paste-shaped: left as ordinary text.
  assert.deepEqual(collectScheduledImageCandidates(instructions, [wrongExt, notUuid]), []);
});

test("candidates edited away or never present are skipped without error", () => {
  const temp = clipboardTempImage();
  assert.deepEqual(collectScheduledImageCandidates("no path here", [temp]), []);
  // The token was edited away between the paste and the staged value: the
  // final instructions no longer contain it verbatim.
  assert.deepEqual(collectScheduledImageCandidates(`text mentioning ${temp.slice(0, -2)} only`, [temp]), []);
});

test("duplicate observations of one source dedup to one candidate", () => {
  const temp = clipboardTempImage();
  const instructions = `See ${temp} twice: ${temp}.`;
  assert.deepEqual(collectScheduledImageCandidates(instructions, [temp, temp]), [temp]);
});

test("a trusted Pi temp image insert keeps recognition when the temp directory contains whitespace", () => {
  // Windows temp directories often contain the user name: the strict UUID
  // image basename carries the recognition, so whitespace inside the trusted
  // temp prefix is allowed, but junk outside it is not.
  const spacedDir = join(tmpdir(), "John Smith temp");
  const spaced = join(spacedDir, `pi-clipboard-${randomUUID()}.png`);
  assert.equal(isPathShapedInsert(spaced, spacedDir), true, "a genuine spaced-temp-dir image insert is path-shaped");
  assert.equal(isPiClipboardTempImagePath(spaced, spacedDir), true);
  // Whitespace outside the trusted prefix is still rejected.
  assert.equal(isPathShapedInsert(` ${spaced} extra `, spacedDir), false);
  // A trailing suffix beyond the image basename is not Pi's paste naming.
  assert.equal(isPiClipboardTempImagePath(`${spaced}.bak`, spacedDir), false);
  // A spaced non-Pi path is still ordinary text.
  assert.equal(isPathShapedInsert(join(spacedDir, "report.txt"), spacedDir), false);
  // Strict naming still gates under a spaced temp dir: wrong extension.
  assert.equal(isPathShapedInsert(join(spacedDir, `pi-clipboard-${randomUUID()}.txt`), spacedDir), false);
});

// ---------------------------------------------------------------------------
// Pi-native clipboard temp recognition (bounded to Pi's own naming)
// ---------------------------------------------------------------------------

test("only Pi's own pi-clipboard temp naming under the OS temp dir is recognized", () => {
  const temp = join(tmpdir(), "pi-clipboard-dddd.png");
  assert.equal(isPiClipboardTempPath(temp), true);
  assert.equal(isPiClipboardTempPath("/work/pi-clipboard-fake.png"), false);
  assert.equal(isPiClipboardTempPath("/tmp/photo.png"), false);
  assert.equal(isPiClipboardTempPath(join(tmpdir(), "pi-clipboard-")), false, "a bare prefix without content is not a temp image path");
});

test("findPiClipboardTempPaths scans only for Pi's own temp naming, whitespace-bounded", () => {
  const temp = join(tmpdir(), "pi-clipboard-eeee.png");
  const instructions = `Check ${temp}, then report. Also ${temp} twice.`;
  // Trailing sentence punctuation is trimmed (a path followed by ","
  // compares equal to the inserted path) and duplicate tokens dedup.
  assert.deepEqual(findPiClipboardTempPaths(instructions), [temp]);
  // A quoted reference is still found: any non-path character delimits a
  // token (a hand-edited/reopened config must not slip past the gate).
  assert.deepEqual(findPiClipboardTempPaths(`Run analyze on "${temp}"`), [temp]);
  // Ordinary typed paths, a "pi-clipboard-" name glued to another word, and
  // text glued to the temp name never match, on any platform.
  assert.deepEqual(findPiClipboardTempPaths("run ls /work/assets/photo.png and api-clipboard-x.png"), []);
  assert.deepEqual(findPiClipboardTempPaths(`see x${temp}`), []);
});

test("unobserved Pi clipboard temp references are exactly those without provenance", () => {
  const temp = join(tmpdir(), "pi-clipboard-ffff.png");
  const typed = "/work/assets/photo.png";
  const instructions = `Compare ${temp} with ${typed}.`;
  assert.deepEqual(findUnobservedPiClipboardTempPaths(instructions, [temp]), []);
  assert.deepEqual(findUnobservedPiClipboardTempPaths(instructions, [`${temp} `]), []);
  assert.deepEqual(findUnobservedPiClipboardTempPaths(instructions, []), [temp]);
  // A quoted reference in a hand-edited/reopened config is still detected.
  assert.deepEqual(findUnobservedPiClipboardTempPaths(`analyze on "${temp}"`, []), [temp]);
  // A genuine UUID-named temp reference is detected the same way.
  const genuine = clipboardTempImage();
  assert.deepEqual(findUnobservedPiClipboardTempPaths(`Check ${genuine}`, []), [genuine]);
  // Ordinary typed paths are never matched by the native-temp recognition.
  assert.deepEqual(findUnobservedPiClipboardTempPaths(`use ${typed}`, []), []);
});

// ---------------------------------------------------------------------------
// Content sniffing
// ---------------------------------------------------------------------------

test("sniffImageType recognizes the supported formats by content, not name", () => {
  assert.equal(sniffImageType(PNG_BYTES), "png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), "jpeg");
  assert.equal(sniffImageType(Buffer.from("GIF89a....")), "gif");
  assert.equal(sniffImageType(Buffer.from("GIF87a....")), "gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4, 0), Buffer.from("WEBP")])), "webp");
  assert.equal(sniffImageType(Buffer.from("%PDF-1.4 plain text")), undefined);
});

// ---------------------------------------------------------------------------
// The Save-time transaction
// ---------------------------------------------------------------------------

test("prepare copies a validated pasted image and rewrites the staged path before persistence", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze this screenshot: ${temp}` }),
      "task-beta": entryOf({ name: "Untouched", instructions: "No images here" }),
    };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));

    const rewritten = prepared.catalog["task-alpha"]!.instructions;
    assert.match(rewritten, /^Analyze this screenshot: /);
    const managed = rewritten.replace("Analyze this screenshot: ", "");
    assert.ok(managed.startsWith(join(root, "task-alpha") + "/"), `the managed path is in the per-task store: ${managed}`);
    assert.ok(!rewritten.includes(temp), "the temporary path no longer appears in the instructions");

    const info = await stat(managed);
    assert.ok(info.isFile());
    assert.equal(info.mode & 0o777, 0o600, "managed files are private 0600");
    assert.deepEqual(await readFile(managed), PNG_BYTES, "the managed copy carries the validated image bytes");
    const rootInfo = await stat(root);
    assert.equal(rootInfo.mode & 0o777, 0o700, "the managed store is private 0700");
    assert.equal((await stat(join(root, "task-alpha"))).mode & 0o777, 0o700, "per-task directories are private 0700");
    // The managed extension reflects the sniffed content, not the source name.
    assert.match(managed, /\.png$/);
    // Unrelated entries are never mutated, and the source stays untouched.
    assert.equal(prepared.catalog["task-beta"]!.instructions, "No images here");
    assert.deepEqual(await readFile(temp), PNG_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("all occurrences of one pasted path share one managed copy", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `First ${temp} then ${temp}.` }),
    };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));
    const rewritten = prepared.catalog["task-alpha"]!.instructions;
    const match = rewritten.match(/^First (\S+) then (\S+)\.$/);
    assert.ok(match, `both occurrences were rewritten: ${rewritten}`);
    assert.equal(match[1], match[2], "both occurrences reference the same managed copy");
    assert.ok(match[1]!.startsWith(join(root, "task-alpha") + "/"));
    const names = (await readdir(join(root, "task-alpha"))).filter((name) => !name.startsWith("."));
    assert.equal(names.length, 1);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("separate task ids get independent assets even for the same source image", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `See ${temp}` }),
      "task-beta": entryOf({ name: "Also pasted", instructions: `See ${temp}` }),
    };
    const provenance = new Map([
      ["task-alpha", [temp]],
      ["task-beta", [temp]],
    ]);
    const prepared = await prepareScheduledImageAssets(configPath, catalog, provenance);
    const alpha = prepared.catalog["task-alpha"]!.instructions.replace("See ", "");
    const beta = prepared.catalog["task-beta"]!.instructions.replace("See ", "");
    assert.notEqual(alpha, beta, "each task id owns its own managed copy");
    assert.ok(alpha.startsWith(join(root, "task-alpha")));
    assert.ok(beta.startsWith(join(root, "task-beta")));
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("a missing pasted source fails Save closed with an actionable message and leaves nothing behind", async () => {
  const { dir, configPath, root } = await prepareFixture();
  try {
    const temp = clipboardTempImage(); // never created
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError && /not readable/.test(error.message),
    );
    assert.equal(await exists(root), false, "no managed store was left behind");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a non-image source (or a text file with an image name) fails Save closed", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage(Buffer.from("plain text, not an image\n"));
  try {
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError && /not a supported image/.test(error.message),
    );
    assert.equal(await exists(root), false, "nothing was copied");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("a source above the bounded size fails Save closed", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage(Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_SCHEDULED_IMAGE_BYTES + 1 - PNG_BYTES.length, 0)]));
  try {
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError && /managed-asset limit/.test(error.message),
    );
    assert.equal(await exists(root), false);
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("an unobserved Pi clipboard temp reference fails Save closed with an actionable message", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = join(tmpdir(), "pi-clipboard-gggg.png"); // no provenance observed
  const genuine = clipboardTempImage(); // genuine naming, still no provenance
  const catalog: ScheduledTaskCatalog = {
    "task-alpha": entryOf({ instructions: `Analyze ${temp}` }),
    "task-beta": entryOf({ name: "No temp reference", instructions: "typed /work/assets/photo.png stays" }),
  };
  try {
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map()),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && /clipboard temp file.*provenance cannot be verified/s.test(error.message)
        && error.message.includes(temp),
    );
    // The fail-closed gate is broader than the copy recognition: a genuine
    // UUID-named temp reference without provenance fails the same way.
    await assert.rejects(
      prepareScheduledImageAssets(configPath, {
        "task-gamma": entryOf({ name: "Genuine name", instructions: `Analyze ${genuine}` }),
      }, new Map()),
      (error: unknown) => error instanceof ScheduledImageAssetError && error.message.includes(genuine),
    );
    assert.equal(await exists(root), false, "nothing was copied");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
  }
});

test("an observed pasted token that was edited away copies nothing and Save proceeds", async () => {
  const { configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: "rewrote the instructions without the image" }),
    };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));
    assert.equal(prepared.catalog["task-alpha"]!.instructions, "rewrote the instructions without the image");
    assert.equal(await exists(root), false, "no copy for an edited-away token");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("an ordinary typed path or command without provenance is never copied and Save proceeds", async () => {
  const { configPath, root } = await prepareFixture();
  const typed = "/work/assets/photo.png";
  const catalog: ScheduledTaskCatalog = {
    "task-alpha": entryOf({ instructions: `Compare the report with ${typed}; run ls ${typed}` }),
  };
  const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map());
  assert.equal(prepared.catalog["task-alpha"]!.instructions, `Compare the report with ${typed}; run ls ${typed}`);
  assert.equal(await exists(root), false, "no silent copy of arbitrary references");
  await rm(dirname(configPath), { recursive: true, force: true });
});

test("plain clipboard text holding an absolute path saves as unchanged text, even a missing one", async () => {
  const { configPath, root } = await prepareFixture();
  // Native Ctrl+V inserts ordinary clipboard text through the same seam as
  // image pastes: a plain absolute path — even one that does not exist — is
  // a text paste. It must not be validated, copied, or failed; native
  // text-paste behavior is unchanged and Save proceeds.
  const missing = "/work/report.txt";
  const catalog: ScheduledTaskCatalog = {
    "task-alpha": entryOf({ instructions: `Read ${missing} and summarize it` }),
  };
  const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [missing]]]));
  assert.equal(prepared.catalog["task-alpha"]!.instructions, `Read ${missing} and summarize it`, "the pasted text is verbatim");
  assert.equal(await exists(root), false, "a text paste creates no managed copy");
  await rm(dirname(configPath), { recursive: true, force: true });
});

test("an ordinary pasted .png path is not copied merely because its contents are an image", async () => {
  const { dir, configPath, root } = await prepareFixture();
  try {
    // A real image file outside Pi's temp naming, observed as an ordinary
    // clipboard-text insert: recognition is bounded to Pi's own temp image
    // naming, never to image content, so nothing is copied and the pasted
    // path stays verbatim text in both entries.
    const pasted = join(dir, "shared-photo.png");
    await writeImage(pasted);
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze ${pasted}` }),
      "task-beta": entryOf({ name: "Typed elsewhere", instructions: `Analyze ${pasted}` }),
    };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [pasted]]]));
    assert.equal(prepared.catalog["task-alpha"]!.instructions, `Analyze ${pasted}`, "a plain image-path paste stays text");
    assert.equal(prepared.catalog["task-beta"]!.instructions, `Analyze ${pasted}`, "other entries stay as text");
    assert.equal(await exists(root), false, "no managed copy for ordinary clipboard text");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing loose managed store directory is tightened to 0700", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    await mkdir(root, { recursive: true });
    await chmod(root, 0o777);
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));
    assert.equal((await stat(root)).mode & 0o777, 0o700, "the store is private after Save");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("a copy failure rolls back exactly the positively created copies", async () => {
  const { configPath, root } = await prepareFixture();
  // Pre-create the store root (not this preparation's creation) and block the
  // second task's directory with a regular file, so the first copy succeeds
  // and the second fails mid-transaction.
  await mkdir(root);
  const temp = await writeTempImage();
  try {
    const blocked = join(root, "task-beta");
    await writeFile(blocked, "not a directory");
    const catalog: ScheduledTaskCatalog = {
      "task-alpha": entryOf({ instructions: `Analyze ${temp}` }),
      "task-beta": entryOf({ name: "Blocked", instructions: `Analyze ${temp}` }),
    };
    const provenance = new Map([
      ["task-alpha", [temp]],
      ["task-beta", [temp]],
    ]);
    await assert.rejects(prepareScheduledImageAssets(configPath, catalog, provenance), ScheduledImageAssetError);
    // The first task's copy and its per-task directory (both positively created
    // by the failed preparation) are removed; the pre-existing root remains.
    assert.deepEqual(await readdir(root), ["task-beta"], "only the pre-existing blocker remains");
  } finally {
    await rm(dirname(configPath), { recursive: true, force: true });
    await rm(temp, { force: true });
  }
});

test("rollback removes only what the preparation created", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));
    assert.ok(prepared.createdFiles.length > 0 && prepared.createdDirs.length >= 2);
    await rollbackScheduledImageAssets(prepared);
    assert.equal(await exists(root), false, "the empty store is fully removed");
    assert.deepEqual(await readFile(temp), PNG_BYTES, "the source is never touched by rollback");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Dispatch-side missing-asset check
// ---------------------------------------------------------------------------

test("dispatch fails closed when a managed asset is missing, and passes when present", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));
    const managed = prepared.catalog["task-alpha"]!.instructions.replace("Analyze ", "");

    assert.deepEqual(findManagedScheduledImagePaths(prepared.catalog["task-alpha"]!.instructions, root), [managed]);
    await assertScheduledImagesPresent(prepared.catalog["task-alpha"]!.instructions, root);
    // A quoted reference (hand-edited/reopened config) is still detected, and
    // a deleted asset behind it still fails the dispatch closed.
    const quoted = `see "${managed}" for context`;
    assert.deepEqual(findManagedScheduledImagePaths(quoted, root), [managed]);
    await rm(managed);
    await assert.rejects(
      assertScheduledImagesPresent(quoted, root),
      (error: unknown) => error instanceof ScheduledImageAssetError && error.message.includes(managed),
    );

    await assert.rejects(
      assertScheduledImagesPresent(prepared.catalog["task-alpha"]!.instructions, root),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && error.message.includes(managed)
        && /re-paste the image or remove the reference/.test(error.message),
    );
    // Text outside the store and glued segments never match the scan.
    assert.deepEqual(findManagedScheduledImagePaths(`ls ${root}-adjacent`, root), []);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("the dispatch scan checks Windows backslash separators and glued Windows segments", () => {
  // Managed paths are produced with the platform separator; on Windows that
  // is a backslash, so the scan must accept it, while glued segments still
  // never match. Exercised here with a synthetic Windows root so the
  // backslash behavior is covered on any platform.
  const winRoot = "C:\\work\\config-dir\\scheduled-image-assets";
  const winManaged = "C:\\work\\config-dir\\scheduled-image-assets\\task-alpha\\img.png";
  assert.deepEqual(findManagedScheduledImagePaths(`run ${winManaged} then report`, winRoot), [winManaged]);
  // A glued segment (no separator after the root) never matches.
  assert.deepEqual(findManagedScheduledImagePaths(`ls ${winRoot}-adjacent`, winRoot), []);
  // A mixed-separator spelling after the same root is also checked: widening
  // the scan only widens the fail-closed existence check.
  const mixedManaged = "C:\\work\\config-dir\\scheduled-image-assets/task-alpha/img.png";
  assert.deepEqual(findManagedScheduledImagePaths(`run ${mixedManaged}`, winRoot), [mixedManaged]);
});

// ---------------------------------------------------------------------------
// Symlinked managed store rejection (never chmod or copy through a link)
// ---------------------------------------------------------------------------

test("a symlinked managed store root is rejected and the symlink target is never touched", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const foreign = join(dir, "foreign-store");
    await mkdir(foreign, { recursive: true });
    await chmod(foreign, 0o755);
    await symlink(foreign, root);
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError && /symbolic link/.test(error.message),
    );
    const foreignInfo = await stat(foreign);
    assert.equal(foreignInfo.mode & 0o777, 0o755, "the symlink target's mode is untouched");
    assert.deepEqual(await readdir(foreign), [], "nothing was copied into the foreign directory");
    assert.equal((await lstat(root)).isSymbolicLink(), true, "the symlink itself was not removed or replaced");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("a symlinked per-task directory is rejected and the symlink target is never touched", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    await mkdir(root);
    const foreign = join(dir, "foreign-task");
    await mkdir(foreign, { recursive: true });
    await chmod(foreign, 0o755);
    const taskLink = join(root, "task-alpha");
    await symlink(foreign, taskLink);
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    await assert.rejects(
      prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]])),
      (error: unknown) => error instanceof ScheduledImageAssetError && /symbolic link/.test(error.message),
    );
    const foreignInfo = await stat(foreign);
    assert.equal(foreignInfo.mode & 0o777, 0o755, "the symlink target's mode is untouched");
    assert.deepEqual(await readdir(foreign), [], "nothing was copied into the foreign directory");
    assert.equal((await lstat(taskLink)).isSymbolicLink(), true, "the symlink itself was not removed or replaced");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Bounded read (race-aware size cap)
// ---------------------------------------------------------------------------

test("readBoundedImage fails closed when a source grows past the limit after its size check", async () => {
  // Simulates the stat/read race directly: the descriptor's content is one
  // byte past the limit even though a stat taken before the read could have
  // reported exactly the limit.
  const { dir } = await prepareFixture();
  const path = join(dir, "growing.png");
  await writeFile(path, Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_SCHEDULED_IMAGE_BYTES + 1 - PNG_BYTES.length, 0)]));
  const handle = await open(path, "r");
  try {
    await assert.rejects(
      readBoundedImage(handle, path),
      (error: unknown) => error instanceof ScheduledImageAssetError
        && error.message.includes(path)
        && /grew past the .*managed-asset limit/.test(error.message),
    );
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("readBoundedImage returns exactly the bounded content for an honest source", async () => {
  const { dir } = await prepareFixture();
  const path = join(dir, "honest.png");
  await writeFile(path, PNG_BYTES);
  const handle = await open(path, "r");
  try {
    assert.deepEqual(await readBoundedImage(handle), PNG_BYTES);
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Persistence-failure rollback (JSON-parsed reference matching)
// ---------------------------------------------------------------------------

test("rollback after a landed persistence failure matches JSON-escaped managed paths", async () => {
  // On POSIX a managed path can legally contain a quote or a backslash; JSON
  // escapes both, so raw-text matching would fail to see a referenced copy
  // and delete an asset the persisted config still names. The rollback must
  // inspect the PARSED saved instructions instead.
  const { dir, configPath } = await prepareFixture();
  try {
    const weirdDir = join(dir, `weird"dir\\sub`);
    await mkdir(weirdDir, { recursive: true });
    const referenced = join(weirdDir, "kept.png");
    const unreferenced = join(weirdDir, "removed.png");
    await writeFile(referenced, PNG_BYTES);
    await writeFile(unreferenced, PNG_BYTES);
    // Simulate a persistence failure whose write already landed with an entry
    // referencing ONLY `referenced` (JSON.stringify escapes " and \).
    await writeFile(configPath, JSON.stringify({
      scheduledTasks: { "task-alpha": { instructions: `Analyze ${referenced}` } },
    }));
    await rollbackScheduledImageAssetsUnlessPersisted(configPath, {
      catalog: {},
      createdFiles: [referenced, unreferenced],
      createdDirs: [],
    });
    assert.equal(await exists(referenced), true, "the JSON-escaped referenced copy survives");
    assert.equal(await exists(unreferenced), false, "the unreferenced copy is rolled back");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("an unparseable config keeps every created copy after a persistence failure", async () => {
  const { dir, configPath, root } = await prepareFixture();
  const temp = await writeTempImage();
  try {
    const catalog: ScheduledTaskCatalog = { "task-alpha": entryOf({ instructions: `Analyze ${temp}` }) };
    const prepared = await prepareScheduledImageAssets(configPath, catalog, new Map([["task-alpha", [temp]]]));
    const managed = prepared.catalog["task-alpha"]!.instructions.replace("Analyze ", "");
    await writeFile(configPath, "{not json at all");
    await rollbackScheduledImageAssetsUnlessPersisted(configPath, prepared);
    assert.equal(await exists(managed), true, "an unparseable config is ambiguous: every copy is kept");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// TUI flow tier: the full /review-settings path through the native bridge
// ---------------------------------------------------------------------------

const keys = (...sequence: string[]): ((component: { handleInput?(data: string): void }) => void) =>
  (component) => {
    for (const key of sequence) component.handleInput?.(key);
  };

async function defaultFlowConfig(dir: string): Promise<Record<string, unknown>> {
  return {
    scheduledTasks: {
      "task-imageaa": {
        name: "Screenshot triage",
        cron: "30 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Analyze the attached screenshot",
        workspace: dir,
      },
      "task-imagebb": {
        name: "Untouched sibling",
        cron: "0 9 * * mon",
        enabled: true,
        kind: "research",
        instructions: "Summarize upstream releases",
        workspace: dir,
      },
    },
  };
}

async function registerFlowHandler(configPath: string): Promise<(ctx: unknown) => Promise<void>> {
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    config,
    configPath,
  });
  assert.ok(handler, "the /review-settings command registered");
  return (ctx) => handler!("", ctx);
}

/**
 * One scripted TUI flow: menus render through the fake menu TUI host, the
 * instructions field through the host-wired bridge editor. `paste` supplies
 * the temp path Pi's native image-paste handler inserts (its terminal act on
 * the editor's public insertTextAtCursor, wrapped by the bridge's
 * observation-only onHostInsert seam); `fieldDriver` settles that field, and
 * `outcome` drives the root menu: save, a failed save (Save, then Esc from
 * the re-shown root), or cancel (Esc at the root, no Save).
 */
async function runImageFlow(
  dir: string,
  options: { paste?: string; fieldDriver?: "submit" | "cancel"; outcome: "save" | "fail" | "cancel"; skipField?: boolean; configJson?: Record<string, unknown> },
): Promise<{ notifyCalls: Array<{ message: string; type?: string }>; instances: FakeBridgeEditor[] }> {
  const instances: FakeBridgeEditor[] = [];
  setMenuTuiHost(createFakeMenuTuiHost());
  setNativeEditorHost(fakeHost(instances));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(options.configJson ?? await defaultFlowConfig(dir), null, 2));
  const run = await registerFlowHandler(configPath);
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const { ui } = createBridgeUi({
    keybindings: fakeKeybindingsManager(),
    draft: "chat draft",
    drivers: [
      keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks
      keys(KEY_ENTER), // list → task entry (row 0)
      ...(options.skipField
        ? [keys(...Array(9).fill(KEY_DOWN), KEY_ENTER)] // entry editor → Back (row 9)
        : [
            keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → instructions (row 3)
            async (component: { handleInput?(data: string): void }): Promise<void> => {
              const editor = instances[0];
              assert.ok(editor, "the bridge editor instance exists");
              if (options.paste !== undefined) {
                // The host's native image-paste handler inserts the temp path
                // through the editor's public insertTextAtCursor; the bridge's
                // observation-only seam records it.
                editor.insertTextAtCursor(` ${options.paste}`);
                assert.ok(editor.getText().includes(options.paste), "the pasted path is in the field text");
              }
              // Settle the field from its own driver: this custom() call
              // consumes exactly one driver step (native Enter submits, Esc
              // cancels).
              component.handleInput?.(options.fieldDriver === "cancel" ? KEY_ESCAPE : ENTER);
            },
            keys(...Array(6).fill(KEY_DOWN), KEY_ENTER), // entry re-show (instructions, row 3) → Back (row 9)
          ]),
      keys(...Array(3).fill(KEY_DOWN), KEY_ENTER), // list re-show (two entries) → Back (row 3)
      ...(options.outcome === "cancel"
        ? [keys(KEY_ESCAPE)] // root: leave without saving
        : [
            keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (scheduled) → Save changes (row 16)
            ...(options.outcome === "fail" ? [keys(KEY_ESCAPE)] : []), // failed save re-shows the root; leave
          ]),
    ],
  });
  const wrapped = {
    ...ui,
    notify(message: string, type?: string): void {
      notifyCalls.push({ message, type });
    },
    async select(): Promise<string | undefined> {
      throw new Error("plain select must not be used in TUI mode with a loadable host");
    },
  };
  try {
    await run({ mode: "tui", scopedModels: [], cwd: dir, ui: wrapped });
  } finally {
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  }
  return { notifyCalls, instances };
}

test("full TUI flow: a native image paste in scheduled instructions is copied to the managed store at Save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-flow-"));
  const temp = await writeTempImage();
  try {
    const { notifyCalls } = await runImageFlow(dir, { paste: temp, fieldDriver: "submit", outcome: "save" });
    assert.deepEqual(notifyCalls.filter((call) => call.type === "error"), [], "Save succeeded cleanly");

    const saved = JSON.parse(await readFile(join(dir, "review-gate.json"), "utf8"));
    const instructions = saved.scheduledTasks["task-imageaa"].instructions as string;
    assert.match(instructions, /^Analyze the attached screenshot /);
    const managed = instructions.replace("Analyze the attached screenshot ", "");
    assert.ok(
      managed.startsWith(join(dir, "scheduled-image-assets", "task-imageaa") + "/"),
      `the managed path is persisted: ${managed}`,
    );
    assert.ok(!instructions.includes(temp), "the temp path is gone from the saved instructions");
    assert.deepEqual(await readFile(managed), PNG_BYTES, "the managed copy carries the validated image bytes");
    assert.equal((await stat(managed)).mode & 0o777, 0o600, "managed files are private 0600");
    assert.equal((await stat(dirname(managed))).mode & 0o777, 0o700, "per-task directories are private 0700");
    assert.equal((await stat(dirname(dirname(managed)))).mode & 0o777, 0o700, "the store root is private 0700");
    // The sibling entry is untouched, and the source file is left alone.
    assert.equal(saved.scheduledTasks["task-imagebb"].instructions, "Summarize upstream releases");
    assert.deepEqual(await readFile(temp), PNG_BYTES);
    // The later-run path: the saved entry's instructions reference a readable
    // managed asset.
    await assertScheduledImagesPresent(instructions, managedScheduledImageRoot(join(dir, "review-gate.json")));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("full TUI flow: cancel after a paste creates no managed copy and leaves the config unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-cancel-"));
  const temp = await writeTempImage();
  try {
    const { notifyCalls } = await runImageFlow(dir, { paste: temp, fieldDriver: "cancel", outcome: "cancel" });
    assert.deepEqual(notifyCalls.filter((call) => call.type === "error"), []);
    const config = await readFile(join(dir, "review-gate.json"), "utf8");
    assert.ok(config.includes("Analyze the attached screenshot"), "the original instructions are intact");
    assert.ok(!config.includes(temp), "the cancelled paste staged nothing");
    assert.equal(await exists(join(dir, "scheduled-image-assets")), false, "root Cancel creates no managed copy");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("full TUI flow: a pasted-but-missing source fails Save with an actionable notice and no mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-missing-"));
  const temp = clipboardTempImage(); // never created
  try {
    const { notifyCalls } = await runImageFlow(dir, { paste: temp, fieldDriver: "submit", outcome: "fail" });
    assert.ok(
      notifyCalls.some((call) => call.type === "error" && call.message.includes(temp) && /not readable/.test(call.message)),
      `Save failed closed with an actionable notice: ${JSON.stringify(notifyCalls)}`,
    );
    assert.equal(await exists(join(dir, "scheduled-image-assets")), false, "a failed Save copies nothing");
    const saved = JSON.parse(await readFile(join(dir, "review-gate.json"), "utf8"));
    assert.equal(saved.scheduledTasks["task-imageaa"].instructions, "Analyze the attached screenshot", "the staged temp path was not persisted");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("full TUI flow: plain clipboard text holding an absolute path saves as unchanged text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-plaintext-"));
  // Pi's native text paste inserts ordinary clipboard text through the same
  // insertTextAtCursor seam as image pastes: a plain absolute path to a real
  // text file is a text paste and must Save normally with verbatim text and
  // no managed copy.
  const notes = join(dir, "notes.txt");
  await writeFile(notes, "plain text report\n");
  try {
    const { notifyCalls } = await runImageFlow(dir, { paste: notes, fieldDriver: "submit", outcome: "save" });
    assert.deepEqual(notifyCalls.filter((call) => call.type === "error"), [], "Save succeeded cleanly");
    const saved = JSON.parse(await readFile(join(dir, "review-gate.json"), "utf8"));
    assert.equal(
      saved.scheduledTasks["task-imageaa"].instructions,
      `Analyze the attached screenshot ${notes}`,
      "the pasted text path is stored verbatim",
    );
    assert.equal(await exists(join(dir, "scheduled-image-assets")), false, "a text paste creates no managed copy");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("full TUI flow: an unobserved Pi clipboard temp reference in a reopened entry fails Save", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-unobs-"));
  const temp = join(tmpdir(), "pi-clipboard-hhhd.png");
  const configPath = join(dir, "review-gate.json");
  try {
    const { notifyCalls } = await runImageFlow(dir, {
      outcome: "fail",
      skipField: true,
      configJson: {
        scheduledTasks: {
          "task-imageaa": {
            name: "Hand-edited temp",
            cron: "30 2 * * *",
            enabled: true,
            kind: "execute",
            instructions: `Analyze ${temp}`,
            workspace: dir,
          },
          "task-imagebb": {
            name: "Untouched sibling",
            cron: "0 9 * * mon",
            enabled: true,
            kind: "research",
            instructions: "Summarize upstream releases",
            workspace: dir,
          },
        },
      },
    });
    assert.ok(
      notifyCalls.some(
        (call) => call.type === "error" && call.message.includes(temp) && /provenance cannot be verified/.test(call.message),
      ),
      `the unobserved temp reference fails Save with an actionable notice: ${JSON.stringify(notifyCalls)}`,
    );
    // The failed Save mutated nothing: the reopened entry's byte-identical
    // instructions are still on disk, including the unverifiable temp path.
    const configAfter = await readFile(configPath, "utf8");
    assert.ok(configAfter.includes(temp), "the temp reference remains for the user to fix");
    assert.deepEqual(JSON.parse(configAfter), {
      scheduledTasks: {
        "task-imageaa": {
          name: "Hand-edited temp",
          cron: "30 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: `Analyze ${temp}`,
          workspace: dir,
        },
        "task-imagebb": {
          name: "Untouched sibling",
          cron: "0 9 * * mon",
          enabled: true,
          kind: "research",
          instructions: "Summarize upstream releases",
          workspace: dir,
        },
      },
    });
    assert.equal(await exists(join(dir, "scheduled-image-assets")), false, "nothing was copied for an unverifiable reference");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("full TUI flow: a __proto__-keyed entry survives Save instead of being deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-sched-proto-"));
  try {
    // JSON.parse creates `__proto__` as an OWN enumerable key; the sibling
    // entry keeps the flow harness's two-entry row geometry intact. Before the
    // prototype-safe fix, expandScheduledTaskWorkspaces dropped the entry one
    // step before validation and the asset transaction, and the Save merge
    // then classified it as staged-then-removed and deleted it from the file.
    const configJson = JSON.parse(`{
      "scheduledTasks": {
        "__proto__": {
          "name": "Prototype id",
          "cron": "30 2 * * *",
          "enabled": true,
          "kind": "execute",
          "instructions": "no path here",
          "workspace": ${JSON.stringify(dir)}
        },
        "task-sibling": {
          "name": "Sibling",
          "cron": "0 9 * * mon",
          "enabled": true,
          "kind": "research",
          "instructions": "no path here either",
          "workspace": ${JSON.stringify(dir)}
        }
      }
    }`);
    const { notifyCalls } = await runImageFlow(dir, { outcome: "save", skipField: true, configJson });
    assert.deepEqual(notifyCalls.filter((call) => call.type === "error"), [], "Save succeeded cleanly");
    const saved = JSON.parse(await readFile(join(dir, "review-gate.json"), "utf8"));
    assert.equal(Object.prototype.hasOwnProperty.call(saved.scheduledTasks, "__proto__"), true, "the id survives Save");
    assert.deepEqual(Object.keys(saved.scheduledTasks).sort(), ["__proto__", "task-sibling"]);
    assert.equal(saved.scheduledTasks["__proto__"].name, "Prototype id");
    // The sibling is untouched, and the saved workspaces are the expanded
    // (unchanged-spelling) values, not the deleted-catalog symptom.
    assert.equal(saved.scheduledTasks["task-sibling"].instructions, "no path here either");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});
