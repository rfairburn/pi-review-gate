/**
 * Real hosted native-image proof through the public Main API and its owned
 * outer PTY. Ghostty environment markers are controlled protocol evidence
 * only; this test does not claim a physical Ghostty display.
 *
 * Each Pi 1.2.0 regular/fullscreen run creates two independent native children
 * and conversations. The pinned `/host-image-proof red|blue` fixture emits a
 * genuine installed pi-tui Image with distinct constant PNG bytes and the same
 * child image ID in both processes. A small test-only trace observes the real
 * Main PTY output: the production writer's `a=t` uploads, translated `a=p`
 * placements, writer-scoped `d=I` image cleanup and `d=i` placement deletes,
 * and final screen restoration.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { supportsSessionHostKittyGraphics } from "../src/session-host/launch";
import {
  ChangeSignal,
  CleanupOutcome,
  EVENT_TIMEOUT_MS,
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  OUTER_COLS,
  OUTER_ROWS,
  TEST_TIMEOUT_MS,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  makeNativeAgentRoot,
  makeRuntimeEnvironment,
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTreePruningTerraform,
  resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";
import { frameHeaderMatches, isSidebarFocusedFrame, parseRosterFrame } from "./helpers/session-host-native-roster-witness";

interface ImageProofFixture {
  readonly FIXED_IMAGE_ID: number;
  readonly RED_PNG_BASE64: string;
  readonly BLUE_PNG_BASE64: string;
}

const proofFixture = require(join(process.cwd(), "tests", "fixtures", "pi-host-image-proof.cjs")) as ImageProofFixture;
const IMAGE_FIXTURE = join(process.cwd(), "tests", "fixtures", "pi-host-image-proof.cjs");
const SIDEBAR_NATIVE_LEFT = 33; // 32 sidebar columns plus the divider.
const TRACE_APC_LIMIT = 128 * 1024;

interface TracedImage {
  readonly id: string;
  readonly base64: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

interface TracedPlacement {
  readonly id: string;
  readonly imageId: string;
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
  readonly crop: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly sequence: number;
}

interface ImageUse {
  readonly id: string;
  readonly base64: string;
  readonly sequence: number;
}

interface ImageDelete {
  readonly id: string;
  readonly sequence: number;
}

interface PlacementDelete {
  readonly imageId: string;
  readonly placementId: string;
  readonly sequence: number;
}

interface PendingUpload {
  readonly id: string;
  readonly chunks: string[];
  bytes: number;
}

/**
 * Bounded, test-only observer for the exact Kitty subset emitted by the real
 * Main frame writer. It is intentionally not a terminal parser: it tracks CSI
 * cursor positioning, complete Kitty APC/ST boundaries, PNG upload chunks,
 * placements, and the exact writer-generated image/placement delete forms
 * only. It is deliberately stricter than a general Kitty terminal parser.
 */
class HostedGraphicsTrace {
  readonly signal = new ChangeSignal();
  readonly uploads: ImageUse[] = [];
  readonly deletes: ImageDelete[] = [];
  readonly placementDeletes: PlacementDelete[] = [];
  readonly primaryRestores: number[] = [];
  readonly images = new Map<string, TracedImage>();
  readonly ownedImageIds = new Set<string>();
  readonly placements = new Map<string, TracedPlacement>();
  failure?: Error;

  private state: "ground" | "escape" | "csi" | "apc-start" | "apc" | "apc-st" = "ground";
  private csi = "";
  private apc = "";
  private pendingUpload?: PendingUpload;
  private cursor?: { readonly row: number; readonly column: number };
  private sequence = 0;

  watermark(): number {
    return this.sequence;
  }

  consume(data: string): void {
    if (this.failure) return;
    try {
      for (const character of data) this.consumeCharacter(character);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error("hosted graphics trace failed");
    }
    this.signal.notify();
  }

  private consumeCharacter(character: string): void {
    switch (this.state) {
      case "ground":
        if (character === "\x1b") this.state = "escape";
        break;
      case "escape":
        if (character === "[") {
          this.csi = "";
          this.state = "csi";
        } else if (character === "_") {
          this.state = "apc-start";
        } else {
          this.state = "ground";
        }
        break;
      case "csi":
        if (character >= "\x40" && character <= "\x7e") {
          this.finishCsi(character);
          this.state = "ground";
        } else if (this.csi.length < 128) {
          this.csi += character;
        } else {
          throw new Error("bounded hosted graphics trace saw an overlong CSI");
        }
        break;
      case "apc-start":
        if (character === "G") {
          this.apc = "";
          this.state = "apc";
        } else {
          this.state = "ground";
        }
        break;
      case "apc":
        if (character === "\x1b") this.state = "apc-st";
        else if (character === "\x9c") {
          this.finishApc();
          this.state = "ground";
        } else this.appendApc(character);
        break;
      case "apc-st":
        if (character === "\\") {
          this.finishApc();
          this.state = "ground";
        } else if (character === "\x1b") {
          this.appendApc("\x1b");
          this.state = "apc-st";
        } else {
          this.appendApc(`\x1b${character}`);
          this.state = "apc";
        }
        break;
    }
  }

  private appendApc(text: string): void {
    if (this.apc.length + text.length > TRACE_APC_LIMIT) {
      throw new Error("bounded hosted graphics trace saw an oversized Kitty APC");
    }
    this.apc += text;
  }

  private finishCsi(final: string): void {
    if ((final === "H" || final === "f") && /^\d+(?:;\d+)?$/.test(this.csi)) {
      const [row, column = "1"] = this.csi.split(";");
      this.cursor = { row: Number(row), column: Number(column) };
    }
    if (this.csi === "?1049" && final === "l") {
      if (this.primaryRestores.length >= 16) throw new Error("hosted graphics trace exceeded its screen-restore bound");
      this.primaryRestores.push(++this.sequence);
    }
  }

  private finishApc(): void {
    const separator = this.apc.indexOf(";");
    const header = separator < 0 ? this.apc : this.apc.slice(0, separator);
    const payload = separator < 0 ? "" : this.apc.slice(separator + 1);
    const params = new Map<string, string>();
    for (const field of header.split(",")) {
      const equals = field.indexOf("=");
      if (equals > 0) params.set(field.slice(0, equals), field.slice(equals + 1));
    }

    if (params.get("a") === "t" && params.get("f") === "100" && params.get("q") === "2") {
      this.consumeUpload(params, payload);
      return;
    }
    if (params.get("a") === undefined && this.pendingUpload) {
      this.consumeUpload(params, payload);
      return;
    }
    if (params.get("a") === "p" && params.get("q") === "2" && params.get("C") === "1") {
      this.consumePlacement(params);
      return;
    }
    if (params.get("a") === "d") {
      const kind = params.get("d");
      const id = params.get("i");
      if (params.get("q") !== "2" || !id || !isWriterKittyId(id)) {
        throw new Error("hosted graphics trace saw an unscoped or unsuppressed delete");
      }
      if (kind === "I" && params.size === 4) {
        if (!this.ownedImageIds.has(id)) throw new Error("hosted graphics trace saw an image delete for an unowned ID");
        if (this.deletes.length >= 256) throw new Error("hosted graphics trace exceeded its delete bound");
        const sequence = ++this.sequence;
        this.deletes.push({ id, sequence });
        this.images.delete(id);
        for (const [placementId, placement] of this.placements) {
          if (placement.imageId === id) this.placements.delete(placementId);
        }
        return;
      }
      if (kind === "i" && params.size === 5) {
        const placementId = params.get("p");
        const placement = placementId ? this.placements.get(placementId) : undefined;
        if (!placementId || !isWriterKittyId(placementId) || !this.images.has(id) || placement?.imageId !== id) {
          throw new Error("hosted graphics trace saw a placement delete outside its exact image/placement pair");
        }
        if (this.placementDeletes.length >= 256) throw new Error("hosted graphics trace exceeded its placement-delete bound");
        this.placementDeletes.push({ imageId: id, placementId, sequence: ++this.sequence });
        this.placements.delete(placementId);
        return;
      }
      throw new Error("hosted graphics trace saw a Kitty delete outside the writer's scoped subset");
    }
    if (this.pendingUpload) throw new Error("hosted graphics APC interrupted a split image upload");
  }

  private consumeUpload(params: ReadonlyMap<string, string>, payload: string): void {
    const id = params.get("i") ?? this.pendingUpload?.id;
    if (!id || payload.length === 0) throw new Error("hosted image upload lacks a bounded ID or payload");
    if (params.get("a") === "t") {
      if (this.pendingUpload) throw new Error("hosted image upload replaced an unfinished transfer");
      if (params.get("m") === "1") {
        this.pendingUpload = { id, chunks: [payload], bytes: payload.length };
        return;
      }
      this.finishUpload(id, payload);
      return;
    }
    const pending = this.pendingUpload;
    if (!pending || pending.id !== id) throw new Error("hosted image continuation has no matching transfer");
    pending.bytes += payload.length;
    if (pending.bytes > TRACE_APC_LIMIT) throw new Error("hosted split image exceeds the trace bound");
    pending.chunks.push(payload);
    if (pending.chunks.length > 32) throw new Error("hosted image exceeds the trace chunk bound");
    if (params.get("m") === "1") return;
    if (params.get("m") !== "0") throw new Error("hosted image continuation has an invalid final chunk marker");
    this.pendingUpload = undefined;
    this.finishUpload(id, pending.chunks.join(""));
  }

  private finishUpload(id: string, base64: string): void {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error("hosted image payload is not canonical base64");
    }
    const png = Buffer.from(base64, "base64");
    if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error("hosted image upload is not a PNG");
    }
    const image: TracedImage = {
      id,
      base64,
      widthPx: png.readUInt32BE(16),
      heightPx: png.readUInt32BE(20),
    };
    if (this.uploads.length >= 128 || this.images.size >= 64) {
      throw new Error("hosted graphics trace exceeded its image bound");
    }
    this.images.set(id, image);
    this.ownedImageIds.add(id);
    this.uploads.push({ id, base64, sequence: ++this.sequence });
  }

  private consumePlacement(params: ReadonlyMap<string, string>): void {
    const imageId = params.get("i");
    const placementId = params.get("p");
    const columns = finiteNonNegative(params.get("c"));
    const rows = finiteNonNegative(params.get("r"));
    const x = finiteNonNegative(params.get("x"));
    const y = finiteNonNegative(params.get("y"));
    const width = finiteNonNegative(params.get("w"));
    const height = finiteNonNegative(params.get("h"));
    const image = imageId ? this.images.get(imageId) : undefined;
    if (!imageId || !placementId || !image || !this.cursor
      || columns === undefined || columns < 1 || rows === undefined || rows < 1
      || x === undefined || y === undefined || width === undefined || width < 1
      || height === undefined || height < 1) {
      throw new Error("hosted Kitty placement lacks its uploaded PNG, CUP, cells, or crop");
    }
    const crop = { x, y, width, height };
    if (x + width > image.widthPx || y + height > image.heightPx) {
      throw new Error("hosted Kitty crop exceeds the uploaded PNG");
    }
    if (!this.placements.has(placementId) && this.placements.size >= 256) {
      throw new Error("hosted graphics trace exceeded its placement bound");
    }
    const sequence = ++this.sequence;
    this.placements.set(placementId, {
      id: placementId,
      imageId,
      column: this.cursor.column - 1,
      row: this.cursor.row - 1,
      columns,
      rows,
      crop,
      sequence,
    });
  }

  activeImagePlacements(): Array<{ readonly image: TracedImage; readonly placement: TracedPlacement }> {
    const output: Array<{ readonly image: TracedImage; readonly placement: TracedPlacement }> = [];
    for (const placement of this.placements.values()) {
      const image = this.images.get(placement.imageId);
      if (image) output.push({ image, placement });
    }
    return output;
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
    if (this.pendingUpload) throw new Error("hosted Kitty image transfer did not reach its final chunk");
  }
}

function finiteNonNegative(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function isWriterKittyId(value: string): boolean {
  const number = finiteNonNegative(value);
  return number !== undefined && number > 0 && number <= 0xffffffff && String(number) === value;
}

interface PlacementWaitOptions {
  readonly afterSequence?: number;
  readonly expectedColumn?: number;
}

function onlyImagePlacement(trace: HostedGraphicsTrace, pngBase64: string): { image: TracedImage; placement: TracedPlacement } {
  const active = trace.activeImagePlacements();
  assert.equal(active.length, 1, "exactly one active hosted image placement is expected");
  assert.equal(active[0]!.image.base64, pngBase64, "the active placement belongs to the expected fixture PNG");
  return active[0]!;
}

async function waitForOnlyImage(
  driver: MainPtyDriver,
  trace: HostedGraphicsTrace,
  pngBase64: string,
  owner: string,
  paneLeft: number,
  paneWidth: number,
  options: PlacementWaitOptions = {},
): Promise<{ imageId: string; placement: TracedPlacement }> {
  const matchesCurrentPlacement = (): boolean => {
    const active = trace.activeImagePlacements();
    if (active.length !== 1 || trace.placements.size !== 1) return false;
    const { image, placement } = active[0]!;
    return image.base64 === pngBase64
      && placement.column >= paneLeft && placement.column + placement.columns <= paneLeft + paneWidth
      && placement.row >= 1 && placement.row + placement.rows <= OUTER_ROWS
      && (options.afterSequence === undefined || placement.sequence > options.afterSequence)
      && (options.expectedColumn === undefined || placement.column === options.expectedColumn);
  };
  await trace.signal.waitFor(
    () => trace.failure !== undefined || matchesCurrentPlacement(),
    EVENT_TIMEOUT_MS,
    `${owner}'s exact PNG has a fresh placement in the expected current pane geometry`,
  );
  trace.assertHealthy();
  assert.ok(frameHeaderMatches(driver.currentText(), owner), `${owner} is the active Main owner when its image is visible`);
  const { image, placement } = onlyImagePlacement(trace, pngBase64);
  assert.equal(image.widthPx, 16);
  assert.equal(image.heightPx, 16);
  assert.ok(placement.columns > 0 && placement.rows > 0);
  assert.deepEqual(placement.crop, { x: 0, y: 0, width: 16, height: 16 },
    "the writer's Kitty source crop covers the actual 16x16 PNG");
  return { imageId: image.id, placement };
}

async function waitForNoPlacedImages(
  trace: HostedGraphicsTrace,
  description: string,
  afterSequence?: number,
  deletedImageId?: string,
): Promise<void> {
  const hasFreshDelete = (): boolean => afterSequence === undefined || trace.deletes.some((deletion) =>
    deletion.sequence > afterSequence && (deletedImageId === undefined || deletion.id === deletedImageId));
  await trace.signal.waitFor(
    () => trace.failure !== undefined || trace.placements.size === 0 && hasFreshDelete(),
    EVENT_TIMEOUT_MS,
    description,
  );
  trace.assertHealthy();
  assert.equal(trace.placements.size, 0, description);
}

function assertWriterNamespaceAndCleanup(trace: HostedGraphicsTrace): void {
  trace.assertHealthy();
  const red = trace.uploads.filter((upload) => upload.base64 === proofFixture.RED_PNG_BASE64);
  const blue = trace.uploads.filter((upload) => upload.base64 === proofFixture.BLUE_PNG_BASE64);
  assert.ok(red.length > 0, "the actual Main writer uploaded the exact red child PNG to the outer PTY");
  assert.ok(blue.length > 0, "the actual Main writer uploaded the exact blue child PNG to the outer PTY");
  const redIds = new Set(red.map((upload) => upload.id));
  const blueIds = new Set(blue.map((upload) => upload.id));
  assert.ok([...redIds].every((id) => !blueIds.has(id)),
    "Main assigns distinct outer Kitty image IDs to children that intentionally reuse one native child image ID");

  const restoredPrimary = trace.primaryRestores.at(-1);
  assert.ok(restoredPrimary !== undefined, "the real Main PTY stream contains primary-screen restoration");
  const relevantIds = new Set([...redIds, ...blueIds]);
  for (const id of relevantIds) {
    const lastUpload = Math.max(...trace.uploads.filter((upload) => upload.id === id).map((upload) => upload.sequence));
    const lastDelete = Math.max(...trace.deletes.filter((deletion) => deletion.id === id).map((deletion) => deletion.sequence), -1);
    assert.ok(lastDelete > lastUpload && lastDelete < restoredPrimary!,
      `writer-owned image ${id} was deleted after its last upload and before outer-screen restoration`);
  }
}

for (const mode of ["regular", "fullscreen"] as const) {
  test(`real native Pi ${mode} images flow through Main compositor and outer PTY`, {
    timeout: TEST_TIMEOUT_MS,
  }, async (t) => {
    const runtime = resolveRuntimePin(t);
    if (!runtime) return;

    const scratch = createOwnedScratchRoot();
    let driver: MainPtyDriver | undefined;
    let trace: HostedGraphicsTrace | undefined;
    let traceSubscription: { dispose(): void } | undefined;
    let assertionsCompleted = false;
    t.after(async () => {
      let cleanup: CleanupOutcome | undefined;
      if (driver) {
        try {
          cleanup = await driver.boundedCleanup();
        } catch {
          try { cleanup = await driver.forceCleanupAndObserve(); } catch {
            cleanup = driver.cleanupStatus(true);
          }
        } finally {
          traceSubscription?.dispose();
          driver.dispose();
        }
      }
      const cleanupConfirmed = cleanup?.childrenExited === true
        && cleanup.shutdownEventsObserved
        && cleanup.gracefulHostExit
        && !cleanup.forced;
      if (assertionsCompleted && cleanupConfirmed) {
        try {
          if (!removeOwnedScratchTreePruningTerraform(scratch)) {
            process.stderr.write(`preserved Main image witness (per-entry ownership receipts unavailable): ${scratch}\n`);
          }
        } catch {
          process.stderr.write("preserved owned Main image scratch: bounded cleanup could not positively remove every entry\n");
        }
      } else {
        const status = cleanup
          ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
          : "cleanup status unavailable";
        process.stderr.write(`preserved owned Main image scratch ${scratch}; assertionsCompleted=${assertionsCompleted}; ${status}\n`);
      }
    });

    assert.equal(proofFixture.FIXED_IMAGE_ID, 0x70524701,
      "both native children use the fixture's same fixed native image ID");
    assert.notEqual(proofFixture.RED_PNG_BASE64, proofFixture.BLUE_PNG_BASE64,
      "the two native children send distinct actual PNG bytes");

    const workspaceA = makeWorkspace(scratch, "image-workspace-a");
    const workspaceB = makeWorkspace(scratch, "image-workspace-b");
    const nativeAgentDir = makeNativeAgentRoot(scratch);
    const observerFile = join(scratch, "observer", "native-images.jsonl");
    const editorLog = createEditorLog(scratch);
    const editor = createEditorExecutable(scratch, join(workspaceA, "unused-editor-target"), editorLog);
    const candidate = compileAndStageCandidate(scratch);
    const env = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
    // Controlled Ghostty capability evidence for Main's output protocol only;
    // this owned virtual PTY is not an observation of a physical display.
    env.TERM_PROGRAM = "ghostty";
    env.TERM = "xterm-ghostty";
    delete env.TMUX;
    delete env.TMUX_PANE;
    delete env.STY;
    delete env.PI_IMAGE_PROTOCOL;
    assert.equal(supportsSessionHostKittyGraphics(env), true,
      "the explicit options.env evidence selects Main's hosted graphics writer without a protocol override");
    assert.deepEqual([env.TERM_PROGRAM, env.TERM, env.TMUX, env.TMUX_PANE, env.STY, env.PI_IMAGE_PROTOCOL],
      ["ghostty", "xterm-ghostty", undefined, undefined, undefined, undefined]);

    const args = [
      "--offline", "--no-context-files", "--no-themes", "--no-tools",
      "--tui-mode", mode,
      "--extension", OBSERVER_FIXTURE,
      "--extension", IMAGE_FIXTURE,
    ];
    driver = await MainPtyDriver.start({
      ptyModule: runtime.pty,
      scratchRoot: scratch,
      candidate,
      runtime,
      observerFile,
      editor,
      editorLog,
      editorValue: "",
      args,
      env,
    });
    trace = new HostedGraphicsTrace();
    traceSubscription = driver.pty.onData((data) => trace!.consume(data));
    await driver.waitFrame((text) => text.includes("Welcome") && text.includes("New session") && text.includes("Quit host"),
      `real public Main starts for native Pi ${mode} mode`);

    const sessionA = await driver.createNativeSession(workspaceA);
    await driver.renameNativeSession(sessionA, "Image proof A");
    const sessionB = await driver.createNativeSession(workspaceB);
    await driver.renameNativeSession(sessionB, "Image proof B");
    assert.notEqual(sessionA.record.pid, sessionB.record.pid, "A and B are independently owned native Pi processes");
    assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId, "A and B have distinct real native conversation IDs");
    assert.equal(sessionA.record.cwd, workspaceA);
    assert.equal(sessionB.record.cwd, workspaceB);
    assert.equal(sessionA.record.tty, true);
    assert.equal(sessionB.record.tty, true);
    assert.equal(processIsAlive(sessionA.record.pid), true);
    assert.equal(processIsAlive(sessionB.record.pid), true);

    await driver.activateRoster("Image proof A");
    await driver.writeAndWait("/host-image-proof red", (text) => text.includes("/host-image-proof red"),
      "A's actual native Pi editor accepts the explicit red image command");
    await driver.writeKeys(KEYS.enter, "A submits /host-image-proof red through its native Pi process");
    await driver.waitFrame((text) => text.includes("host-image-proof: red"), "A's native custom message renders");
    const firstRed = await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64,
      "Image proof A", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT);
    const redWriterId = firstRed.imageId;
    const redNativeAnchor = firstRed.placement.column - SIDEBAR_NATIVE_LEFT;

    const beforeSiblingSwitch = onlyImagePlacement(trace, proofFixture.RED_PNG_BASE64);
    const siblingSwitchWatermark = trace.watermark();
    await driver.activateRoster("Image proof B");
    await waitForNoPlacedImages(trace,
      "switching to image-free B deletes A's sibling image before B renders one",
      siblingSwitchWatermark, beforeSiblingSwitch.image.id);
    await driver.writeAndWait("/host-image-proof blue", (text) => text.includes("/host-image-proof blue"),
      "B's actual native Pi editor accepts the explicit blue image command");
    await driver.writeKeys(KEYS.enter, "B submits /host-image-proof blue through its native Pi process");
    await driver.waitFrame((text) => text.includes("host-image-proof: blue"), "B's native custom message renders");
    const firstBlue = await waitForOnlyImage(driver, trace, proofFixture.BLUE_PNG_BASE64,
      "Image proof B", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT);
    const blueWriterId = firstBlue.imageId;
    const blueNativeAnchor = firstBlue.placement.column - SIDEBAR_NATIVE_LEFT;
    assert.notEqual(redWriterId, blueWriterId,
      "the same native child image ID is namespaced to distinct Main-owned outer image IDs");
    assert.ok(!trace.activeImagePlacements().some(({ image }) => image.base64 === proofFixture.RED_PNG_BASE64),
      "B never displays A's image as its sibling surface");

    const beforeReturnToA = trace.watermark();
    await driver.activateRoster("Image proof A");
    await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64,
      "Image proof A", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: beforeReturnToA, expectedColumn: redNativeAnchor + SIDEBAR_NATIVE_LEFT });
    assert.ok(!trace.activeImagePlacements().some(({ image }) => image.base64 === proofFixture.BLUE_PNG_BASE64),
      "switching back to A removes B's sibling graphic");
    assert.ok(processIsAlive(sessionB.record.pid), "switching image ownership never exits B");

    // Two explicit F8 transitions distinguish focus from hide. The active A
    // image remains in the right pane while visible, then moves to the full
    // width when hidden, and returns outside the sidebar when shown again.
    await driver.toggleSidebar();
    assert.equal(driver.sidebarVisible, true);
    assert.equal(driver.focus, "sidebar");
    await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64,
      "Image proof A", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT);
    const visibleBeforeHide = onlyImagePlacement(trace, proofFixture.RED_PNG_BASE64);
    const hideWatermark = trace.watermark();
    const beforeHide = driver.records().length;
    await driver.toggleSidebar();
    assert.equal(driver.sidebarVisible, false);
    assert.equal(driver.focus, "main");
    await driver.waitForRecords((records) => records.slice(beforeHide).some((record) => record.type === "resize"
      && record.pid === sessionA.record.pid && record.columns === OUTER_COLS && record.rows === 49),
    "hiding the sidebar resizes A's actual native PTY to the full-width pane");
    const hiddenImage = await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64, "Image proof A", 0, OUTER_COLS,
      { afterSequence: hideWatermark, expectedColumn: visibleBeforeHide.placement.column - SIDEBAR_NATIVE_LEFT });

    const showWatermark = trace.watermark();
    const beforeShow = driver.records().length;
    await driver.toggleSidebar();
    assert.equal(driver.sidebarVisible, true);
    assert.equal(driver.focus, "sidebar");
    await driver.waitForRecords((records) => records.slice(beforeShow).some((record) => record.type === "resize"
      && record.pid === sessionA.record.pid && record.columns === OUTER_COLS - SIDEBAR_NATIVE_LEFT && record.rows === 49),
    "showing the sidebar restores A's actual native PTY to the right-hand pane width");
    await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64,
      "Image proof A", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: showWatermark, expectedColumn: hiddenImage.placement.column + SIDEBAR_NATIVE_LEFT });

    // Open and cancel the real Workspace-only host form over A. The old image
    // must be deleted while the form owns the pane, then A's current native
    // graphic must be accepted again after cancellation.
    const redBeforeForm = onlyImagePlacement(trace, proofFixture.RED_PNG_BASE64);
    const formWatermark = trace.watermark();
    await driver.moveRosterTo("New session");
    const beforeForm = driver.frameRevision;
    driver.pty.write(KEYS.enter);
    driver.focus = "form";
    await driver.waitFrame((text) => text.includes("New session") && text.includes("Workspace:")
      && !text.includes("> New name:"), "the real New-session form owns the main pane", beforeForm);
    await waitForNoPlacedImages(trace, "the form pane contains no stale native image placement",
      formWatermark, redBeforeForm.image.id);
    const beforeCancel = driver.frameRevision;
    const cancelWatermark = trace.watermark();
    driver.pty.write(KEYS.escape);
    driver.focus = "sidebar";
    await driver.waitFrame((text) => !text.includes("Workspace:")
      && parseRosterFrame(text, 32).complete
      && isSidebarFocusedFrame(text, 32)
      && frameHeaderMatches(text, "Image proof A"),
    "Escape cancels only the host form and returns to A's complete visible roster", beforeCancel);
    await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64,
      "Image proof A", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: cancelWatermark, expectedColumn: redBeforeForm.placement.column });

    const beforeResizeOwnerSwitch = onlyImagePlacement(trace, proofFixture.RED_PNG_BASE64);
    const resizeOwnerSwitchWatermark = trace.watermark();
    await driver.activateRoster("Image proof B");
    await waitForOnlyImage(driver, trace, proofFixture.BLUE_PNG_BASE64,
      "Image proof B", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: resizeOwnerSwitchWatermark, expectedColumn: blueNativeAnchor + SIDEBAR_NATIVE_LEFT });
    assert.ok(trace.deletes.some((deletion) => deletion.id === beforeResizeOwnerSwitch.image.id
      && deletion.sequence > resizeOwnerSwitchWatermark),
    "switching to B deletes A's old graphic even when the writer replaces it in one output frame");
    await driver.ensureSidebarFocus();
    const blueBeforeNarrow = onlyImagePlacement(trace, proofFixture.BLUE_PNG_BASE64);
    const narrowWatermark = trace.watermark();
    await driver.setOuterSize(52, 30, [sessionA, sessionB], 52, 29);
    assert.equal(driver.surface.frame().cols, 52, "the outer terminal is now in the narrow overlay geometry");
    await driver.waitFrame((text) => parseRosterFrame(text, 52).complete && isSidebarFocusedFrame(text, 52),
      "the narrow full-width roster overlay finishes painting");
    await waitForNoPlacedImages(trace, "the narrow sidebar overlay contains no stale native image placement",
      narrowWatermark, blueBeforeNarrow.image.id);
    const wideRestoreWatermark = trace.watermark();
    await driver.setOuterSize(OUTER_COLS, OUTER_ROWS, [sessionA, sessionB], OUTER_COLS - 32 - 1, 49);
    assert.equal(driver.surface.frame().cols, OUTER_COLS, "the outer terminal returns to wide geometry");
    await waitForOnlyImage(driver, trace, proofFixture.BLUE_PNG_BASE64,
      "Image proof B", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: wideRestoreWatermark, expectedColumn: blueBeforeNarrow.placement.column });
    assert.ok(processIsAlive(sessionA.record.pid) && processIsAlive(sessionB.record.pid),
      "wide/narrow resize and image re-render leave both exact native children alive");

    // The fixture is a direct slash command, not a provider/model/tool path.
    assert.equal(driver.records().some((record) => record.type === "agent_start"), false,
      "neither explicit native image command starts a model turn");
    assert.equal(driver.records().some((record) => record.type === "tool_call"), false,
      "the image proof invokes no native tools");

    const closeSwitchWatermark = trace.watermark();
    await driver.activateRoster("Image proof A");
    await waitForOnlyImage(driver, trace, proofFixture.RED_PNG_BASE64,
      "Image proof A", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: closeSwitchWatermark, expectedColumn: redNativeAnchor + SIDEBAR_NATIVE_LEFT });
    const redBeforeExit = onlyImagePlacement(trace, proofFixture.RED_PNG_BASE64);
    const redExitWatermark = trace.watermark();
    await driver.closeNativeNormally(sessionA);
    await waitForNoPlacedImages(trace, "A's exact native exit removes its active writer-owned image",
      redExitWatermark, redBeforeExit.image.id);

    const blueReturnWatermark = trace.watermark();
    await driver.activateRoster("Image proof B");
    await waitForOnlyImage(driver, trace, proofFixture.BLUE_PNG_BASE64,
      "Image proof B", SIDEBAR_NATIVE_LEFT, OUTER_COLS - SIDEBAR_NATIVE_LEFT,
      { afterSequence: blueReturnWatermark, expectedColumn: blueNativeAnchor + SIDEBAR_NATIVE_LEFT });
    const blueBeforeExit = onlyImagePlacement(trace, proofFixture.BLUE_PNG_BASE64);
    const blueExitWatermark = trace.watermark();
    await driver.closeNativeNormally(sessionB);
    await waitForNoPlacedImages(trace, "B's exact native exit removes its active writer-owned image",
      blueExitWatermark, blueBeforeExit.image.id);

    // The existing driver proves each exact child PID through its kernel exit
    // watcher and real PTY onExit record, then proves Main result/TTY/raw-mode
    // restoration on normal host Quit. No result-file substitute or forced kill.
    await driver.assertGracefulPtyExits([sessionA, sessionB]);
    assert.equal(sessionA.exitWatcher.observedExit, true);
    assert.equal(sessionB.exitWatcher.observedExit, true);
    await driver.finishHostNormally();
    const outcome = driver.cleanupStatus();
    assert.deepEqual(outcome, {
      childrenExited: true,
      shutdownEventsObserved: true,
      hostExited: true,
      gracefulHostExit: true,
      forced: false,
    }, "the exact children, public Main result, and outer restoration all settled gracefully");
    assertWriterNamespaceAndCleanup(trace);
    await driver.stopNativeExitWatchers();
    traceSubscription.dispose();
    traceSubscription = undefined;
    assertionsCompleted = true;
  });
}
