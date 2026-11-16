/**
 * Explicit Node-side self-check for the Android owner acceptance fixture.
 *
 * It is NOT part of the default test suite and runs only when invoked directly:
 *
 *   node dist-test/tests/android-native-acceptance/node-viewer-selfcheck.js
 *
 * It drives the SAME owner stack the Android suite uses (real peer coordinator,
 * real owning-host service, real `InstanceManager`, real `node-pty` children of
 * the synthetic interactive CLI) with a production TypeScript VIEWER coordinator
 * in place of the phone: real TLS pairing on both sides, a real content
 * subscription, real viewer-scoped input reaching the child's TTY, and a real
 * hosted-provider TEXT copy arriving at the viewer's own copy callback.
 *
 * Proof level: SAME-HOST POSIX only. The viewer here is a TypeScript coordinator,
 * not an Android surface, so this check proves the fixture and the owner lane are
 * real and runnable; it proves nothing about the device UI, the platform
 * clipboard, or a written Android frame. The Android instrumentation run is what
 * covers those, and it must be run separately.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createStatusBroker, type StatusBroker } from "../../src/session-host/broker";
import { InstanceManager, type InstanceManagerOptions, type StatusRegistrar } from "../../src/session-host/instances";
import { createLocalOwningHostService } from "../../src/session-host/owning-host-service";
import { createPeerCoordinator } from "../../src/session-host/network/peer-coordinator";
import { nativeIoSourceEquals } from "../../src/session-host/network/session-content-protocol";
import type { PeerNativeCopyReceipt, PeerNativeInputTarget } from "../../src/session-host/network/peer-content";
import type { PeerUiSnapshot } from "../../src/session-host/peer-ui-protocol";
import { COPY_TRIGGER, startOwnerFixture } from "./owner-fixture";

const RUN = `selfcheck${Date.now().toString(36)}`;
const MARKER = `MK${Date.now().toString(36)}`;
const VIEWER_LABEL = "pi-session-host";
const BOUND_MS = 30_000;

/** The repository root, so the check runs from any working directory. */
function packageRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = join(directory, "..");
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

function log(message: string): void {
  process.stdout.write(`selfcheck: ${message}\n`);
}

/**
 * Await a predicate using only real event wakeups. The timer is the deadline, not
 * a poll interval: nothing re-reads the predicate until an actual event fires.
 */
async function until(predicate: () => boolean, what: string, wake: { current: (() => void) | null }): Promise<void> {
  const deadline = Date.now() + BOUND_MS;
  for (;;) {
    if (predicate()) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolvePromise) => {
      wake.current = resolvePromise;
      setTimeout(() => wake.current?.(), remaining);
    });
  }
}

/**
 * A real owning-host service for the VIEWER side, exactly as a real requester host
 * has one: one real `InstanceManager`, one real broker. This viewer hosts no rows,
 * so its PTY factory refuses and its status registrar refuses; either being
 * reached is a fixture bug, never a silent success.
 */
async function makeViewerInventory(root: string): Promise<{
  readonly service: ReturnType<typeof createLocalOwningHostService>;
  readonly broker: StatusBroker;
  readonly manager: InstanceManager;
}> {
  const agentDir = join(root, "viewer-native-agent");
  const packageRoot = join(root, "viewer-gate-package");
  mkdirSync(agentDir, { mode: 0o700 });
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic inert gate fixture; never imported or executed.\n", "utf8");
  }
  const piExecutable = join(root, "viewer-bin", "pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n// Synthetic inert Pi executable fixture; this viewer spawns nothing.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const broker = await createStatusBroker({ socketRoot: realpathSync(mkdtempSync("/tmp/prg-")) });
  const refuseRegistrar = {
    register(): never { throw new Error("the self-check viewer hosts no rows; a status registration is a fixture bug"); },
  } as unknown as StatusRegistrar;
  const options: InstanceManagerOptions = {
    packageRoot,
    piExecutable,
    statusRegistrar: refuseRegistrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    ptyFactory: () => { throw new Error("the self-check viewer hosts no rows; a spawn is a fixture bug"); },
  };
  const manager = new InstanceManager(options);
  const service = createLocalOwningHostService({ createManager: () => manager, teardownRequested: () => false });
  service.openManager(options);
  return { service, broker, manager };
}

/** What the owner fixture reports when it tears itself down. */
type OwnerSettled = {
  readonly childrenRemaining: number;
  readonly problems: readonly string[];
  readonly evidenceDirectory: string;
};

async function main(): Promise<void> {
  const base = realpathSync(mkdtempSync("/tmp/prg-selfcheck-"));
  const root = join(base, "run");
  mkdirSync(root, { mode: 0o700 });
  const ownerWake = { current: null as (() => void) | null };
  const viewerWake = { current: null as (() => void) | null };
  let copyReceipts: PeerNativeCopyReceipt[] = [];
  let proofCalls = 0;

  // Every owned resource registers its release AT ACQUISITION, and the releases always
  // run afterwards in reverse acquisition order — success, failed assertion, or timeout.
  // A failed check must still confirm child exit, run the owner's evidence-preservation
  // lifecycle, and close the viewer's own sockets; a PASS is reported only when the
  // check and every one of those releases came back clean.
  const cleanup: { label: string; run: () => Promise<void> }[] = [];
  let checkError: unknown;
  let ownerSettled: OwnerSettled | undefined;
  const runCleanup = async (): Promise<string[]> => {
    const problems: string[] = [];
    for (const step of [...cleanup].reverse()) {
      try {
        await step.run();
      } catch (error) {
        problems.push(`${step.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems;
  };

  try {
    const owner = await startOwnerFixture({
      run: RUN,
      listenHost: "127.0.0.1",
      listenPort: 0,
      backends: ["claude"],
      childScript: join(packageRoot(), "tests", "android-native-acceptance", "synthetic-native-cli.cjs"),
      rootParent: join(base, "owner"),
      marker: MARKER,
      deviceLabel: VIEWER_LABEL,
    }, { onIncomingConsent: () => { ownerWake.current?.(); } });
    cleanup.push({
      label: "owner shutdown",
      // A failed check tears down as a reported failure, so the owner preserves its
      // journals under a -failed- evidence directory instead of discarding them.
      run: async () => {
        ownerSettled = await owner.shutdown(checkError === undefined ? "success" : "reported-failure");
      },
    });
    log(`owner ready on port ${owner.port}, row ${owner.rows[0]?.rowId}`);

    const viewerAgentDir = join(root, "viewer-agent");
    mkdirSync(viewerAgentDir, { mode: 0o700 });
    const viewerInventory = await makeViewerInventory(root);
    cleanup.push(
      {
        label: "viewer status broker",
        run: async () => {
          await viewerInventory.broker.dispose();
        },
      },
      {
        label: "viewer instance manager",
        run: async () => {
          await viewerInventory.manager.shutdown();
          await viewerInventory.manager.dispose();
        },
      },
    );
    let viewerSnapshot: PeerUiSnapshot | null = null;

    const viewer = createPeerCoordinator({
      agentDir: viewerAgentDir,
      inventory: viewerInventory.service,
      onChange: (snapshot) => {
        viewerSnapshot = snapshot;
        viewerWake.current?.();
      },
      onIncomingConsentArrival: () => viewerWake.current?.(),
      onContentChange: () => viewerWake.current?.(),
      nativeIo: {
        // A real proof, not a constant: the target must still be this endpoint's own
        // currently published source. On a device this same seam re-proves an actual
        // written, uncovered, focused Android frame instead.
        authorizeInput: (target: PeerNativeInputTarget): boolean => {
          proofCalls += 1;
          const published = viewer.content.readNativeInputTarget?.();
          if (published === undefined) return false;
          return published.subscriptionId === target.subscriptionId
            && published.selectionGeneration === target.selectionGeneration
            && published.hostId === target.hostId
            && nativeIoSourceEquals(published.source, target.source);
        },
        onCopy: (receipt) => {
          copyReceipts.push(receipt);
          viewerWake.current?.();
        },
      },
    });
    cleanup.push({
      label: "viewer coordinator close",
      run: async () => {
        await viewer.close();
      },
    });
    await viewer.start();
    await viewer.perform({ type: "peer-viewer-native-input", enabled: true });
    await viewer.perform({ type: "peer-add", label: VIEWER_LABEL, host: "127.0.0.1", port: String(owner.port) });
    const hostId = viewer.read().hosts?.[0]?.id;
    assert.ok(hostId, "the destination was saved");
    void viewer.perform({ type: "peer-connect", hostId });

    // Real first-use consents on BOTH sides.
    await until(() => (viewerSnapshot?.consents ?? []).some((c) => c.kind === "server-key"), "the viewer's server-key consent", viewerWake);
    const serverKey = viewer.read().consents.find((c) => c.kind === "server-key");
    assert.ok(serverKey !== undefined && viewer.decideConsent(serverKey.id, "approve"), "the viewer approved the owner key");
    await until(() => owner.pendingIncomingConsents().length > 0, "the owner's incoming pairing request", ownerWake);
    const incoming = owner.pendingIncomingConsents();
    assert.equal(incoming.length, 1, "exactly one pairing request reached the owner");
    assert.equal(incoming[0]?.label, VIEWER_LABEL, "the pairing request carries the claimed viewer label");
    assert.ok(owner.decide(incoming[0]!.id, "approve"), "the owner approved the claimed viewer key");

    await until(() => {
      const host = viewer.read().hosts?.[0];
      return host?.state === "connected" && (host.roster.rows ?? []).some((row) => row.id === owner.rows[0]?.rowId);
    }, "the owner roster with the fixture row", viewerWake);
    log("paired and connected; the roster carries the fixture row");

    const ownerRow = owner.rows[0]!;
    viewer.content.selectContent({
      hostId,
      hostRunId: owner.hostRunId,
      rowId: ownerRow.rowId,
      selectionGeneration: 1,
      cols: 80,
      rows: 24,
    });
    await until(() => viewer.content.readNativeInputTarget?.() !== undefined, "a published content view with a native input source", viewerWake);
    let target = viewer.content.readNativeInputTarget!();
    assert.ok(target !== undefined, "the endpoint described a native input target");
    log("the content stream published a native input source");

    // The one manager's own viewer facts for the fixture row: the phone's live
    // viewer, its revision, and the geometry its written frame was admitted under.
    const viewers = owner.viewerRows();
    assert.equal(viewers.length, 1, "exactly one live viewer displays the fixture row");
    assert.equal(viewers[0]?.rowId, ownerRow.rowId, "that viewer displays this fixture row");
    assert.ok((viewers[0]?.viewerRevision ?? 0) >= 1, "the viewer carries a live revision");
    assert.deepEqual(
      { cols: viewers[0]?.geometry?.cols, rows: viewers[0]?.geometry?.rows },
      { cols: 80, rows: 24 },
      "the row is resized to the viewer's own requested viewport",
    );
    log(`the owner reports the viewer at ${viewers[0]?.geometry?.cols}x${viewers[0]?.geometry?.rows}, revision ${viewers[0]?.viewerRevision}`);

    /** The newest snapshot this viewer actually received: its sequence and rendered text. */
    const published = (): { sequence: number; cols: number; text: string } => {
      const snapshot = (viewer.content.readContent().view as unknown as
        | { snapshot?: { meta?: { sequence?: number }; frame?: { cols?: number; lines?: string[] } } }
        | undefined)?.snapshot;
      return {
        sequence: snapshot?.meta?.sequence ?? -1,
        cols: snapshot?.frame?.cols ?? -1,
        text: (snapshot?.frame?.lines ?? []).join("\n"),
      };
    };

    /* ------------------------------------------------------------------ *
     * The resize bootstrap, before ANY input.
     *
     * The owned child repaints when its PTY really resizes (also proven against the
     * child's own TTY in tests/android-native-acceptance-child-resize.test.ts), and
     * this lane has to SHOW that repaint: the viewer must receive a NEWER published
     * snapshot — a higher sequence, at the new width — whose text carries the banner
     * the child itself drew. A source restatement or the owner's own viewport capture
     * is not enough, and neither is the child's journal. Nothing has been typed yet,
     * so every input and copy counter must still read zero.
     * ------------------------------------------------------------------ */
    const RESIZED_COLS = 96;
    const RESIZED_ROWS = 32;
    const BANNER = `tty=${RESIZED_COLS}x${RESIZED_ROWS}`;
    const publishedBeforeResize = published();
    const resizeBefore = owner.summarize("claude");
    assert.equal(resizeBefore.stdinRecords, 0, "no PTY input has been sent yet in this run");
    assert.equal(resizeBefore.osc52Emitted, 0, "no child copy has been emitted yet in this run");
    assert.equal(resizeBefore.markerHits, 0, "the run marker has not reached any child yet");
    viewer.content.updateContentViewport({ selectionGeneration: 1, cols: RESIZED_COLS, rows: RESIZED_ROWS });
    await until(
      () => {
        const geometry = owner.viewerRows()[0]?.geometry;
        return geometry?.cols === RESIZED_COLS && geometry?.rows === RESIZED_ROWS;
      },
      "the owner applying the viewer's new viewport to the row",
      ownerWake,
    );
    await until(
      () => owner.summarize("claude").ttyResizes > resizeBefore.ttyResizes,
      "the owned child receiving the real PTY resize",
      ownerWake,
    );
    const resized = owner.summarize("claude");
    assert.deepEqual(
      resized.ttyResizeGeometry,
      { cols: RESIZED_COLS, rows: RESIZED_ROWS },
      "the child's own terminal reported the new size",
    );
    await until(
      () => {
        const now = published();
        return now.sequence > publishedBeforeResize.sequence
          && now.cols === RESIZED_COLS
          && now.text.includes(BANNER);
      },
      `a newer published snapshot (sequence > ${publishedBeforeResize.sequence}) at ${RESIZED_COLS} columns carrying the child's own redrawn ${BANNER} banner`,
      viewerWake,
    );
    await until(
      () => {
        const source = viewer.content.readNativeInputTarget?.()?.source as
          | { geometry?: { cols?: number; rows?: number } }
          | undefined;
        return source?.geometry?.cols === RESIZED_COLS && source?.geometry?.rows === RESIZED_ROWS;
      },
      "the owner restating an input source at the row's new geometry",
      viewerWake,
    );
    const resizedSource = viewer.content.readNativeInputTarget?.()?.source as { phase?: string } | undefined;
    assert.equal(resizedSource?.phase, "native-cli", "the republished view still carries the native CLI input source");
    const afterResize = owner.summarize("claude");
    assert.equal(afterResize.stdinRecords, 0, "the resize bootstrap involved no PTY input");
    assert.equal(afterResize.osc52Emitted, 0, "the resize bootstrap emitted no copy");
    assert.equal(afterResize.markerHits, 0, "the resize bootstrap carried no run marker");
    // The published source moved with the geometry, so every later write uses the
    // target as it stands now rather than the one read before the resize.
    target = viewer.content.readNativeInputTarget!();
    assert.ok(target !== undefined, "the endpoint still describes a native input target after the resize");
    log(`the owner applied the ${RESIZED_COLS}x${RESIZED_ROWS} viewport, the owned child received that real PTY resize, the owner restated the source at it, and every input and copy counter is still zero`);

    const before = owner.summarize("claude");
    const afterViewport = published();
    const typed = await viewer.content.sendNativeInput!({
      hostId: target.hostId,
      selectionGeneration: target.selectionGeneration,
      subscriptionId: target.subscriptionId,
      source: target.source,
      inputModes: target.inputModes,
      kind: "keyboard",
      text: `${MARKER}\r`,
    });
    assert.equal(typed.status, "submitted", `viewer input was submitted (${typed.status})`);
    await until(() => owner.summarize("claude").markerHits !== null
      && (owner.summarize("claude").markerHits ?? 0) > 0, "the child journal witnessing the typed marker", ownerWake);
    const afterInput = owner.summarize("claude");
    assert.ok(afterInput.stdinRecords > before.stdinRecords, "the owned child received more raw stdin than before");
    // The child's answer has to reach this viewer as a NEWER publish too, under the
    // same written-source standing: a journal counter alone is not delivery.
    await until(
      () => {
        const now = published();
        return now.sequence > afterViewport.sequence
          && now.text.includes(MARKER);
      },
      `a newer published snapshot (sequence > ${afterViewport.sequence}) echoing the typed ${MARKER}`,
      viewerWake,
    );
    log(`the child journaled the typed marker (${afterInput.stdinBytes} raw bytes total) and the echo arrived in a newer publish`);

    // The manager's own viewer facts for the fixture row: the live viewer, its
    // revision, and the geometry the written input was admitted under — which is the
    // resized viewport, not the one the PTY was spawned with.
    const viewersAfterInput = owner.viewerRows();
    assert.equal(viewersAfterInput.length, 1, "exactly one live viewer displays the fixture row");
    assert.equal(viewersAfterInput[0]?.rowId, ownerRow.rowId, "that viewer displays this fixture row");
    assert.ok((viewersAfterInput[0]?.viewerRevision ?? 0) >= 1, "the viewer carries a live revision");
    assert.deepEqual(
      { cols: viewersAfterInput[0]?.geometry?.cols, rows: viewersAfterInput[0]?.geometry?.rows },
      { cols: RESIZED_COLS, rows: RESIZED_ROWS },
      "the written input was admitted under the row's resized viewport",
    );

    const copyBefore = afterInput.osc52Emitted;
    const copyKey = await viewer.content.sendNativeInput!({
      hostId: target.hostId,
      selectionGeneration: target.selectionGeneration,
      subscriptionId: target.subscriptionId,
      source: target.source,
      inputModes: target.inputModes,
      kind: "keyboard",
      text: COPY_TRIGGER,
    });
    assert.equal(copyKey.status, "submitted", `the copy trigger was submitted (${copyKey.status})`);
    await until(() => owner.summarize("claude").osc52Emitted > copyBefore, "the child's own OSC 52 emission", ownerWake);
    await until(() => copyReceipts.length > 0, "the copy frame at the viewer", viewerWake);
    const receipt = copyReceipts[0]!;
    const event = receipt.event as { kind?: string; encoded?: string; backend?: string };
    assert.equal(event.backend, "claude", "the hosted-provider copy names that row's backend and carries no tuple");
    assert.ok(typeof event.encoded === "string" && event.encoded.length > 0, "the copy carried a non-empty encoded payload");
    const decoded = Buffer.from(event.encoded as string, "base64").toString("utf8");
    assert.ok(decoded.includes(RUN), "the copied text carries this run's nonce");
    log(`the viewer received the text copy: ${decoded}`);

    // Viewer preference OFF: the input is refused before anything reaches the owner,
    // and the child's raw-stdin witness does not move.
    await viewer.perform({ type: "peer-viewer-native-input", enabled: false });
    // Baseline AFTER the copy trigger, so the refused attempt is compared against the
    // last real child input rather than against an earlier point in the run.
    const afterCopy = owner.summarize("claude");
    const refused = await viewer.content.sendNativeInput!({
      hostId: target.hostId,
      selectionGeneration: target.selectionGeneration,
      subscriptionId: target.subscriptionId,
      source: target.source,
      inputModes: target.inputModes,
      kind: "keyboard",
      text: `${MARKER}-after-off\r`,
    });
    assert.notEqual(refused.status, "submitted", "a viewer with remote input Off never submits bytes");
    const afterOff = owner.summarize("claude");
    assert.equal(afterOff.stdinRecords, afterCopy.stdinRecords, "no owner writer ran while the viewer preference was Off");
    assert.equal(afterOff.markerHits, afterCopy.markerHits, "the refused text never reached the child's TTY");
    log(`remote input Off refused the write (${refused.status}) with no child bytes`);

    // The out-of-band trigger makes the CHILD emit OSC 52 without any viewer PTY
    // bytes, so the frozen recipient cannot be stolen by the test itself.
    const oobBefore = owner.summarize("claude").osc52Emitted;
    owner.requestOutOfBandCopy("claude");
    await until(() => owner.summarize("claude").osc52Emitted > oobBefore, "the out-of-band child emission", ownerWake);
    assert.equal(owner.summarize("claude").stdinRecords, afterOff.stdinRecords, "the out-of-band emission involved no PTY input");
    log("the out-of-band child emission happened with zero new PTY input");
  } catch (error) {
    // Recorded, not swallowed: cleanup runs first, then this is rethrown so the
    // self-check still exits nonzero with the original stack.
    checkError = error;
  }

  const cleanupProblems = await runCleanup();
  const settled = ownerSettled;
  // Deletion is gated on COMPLETE settlement: the owner deliberately keeps its root
  // when a shutdown step or a child settlement fails, and a recursive delete here must
  // never override that protection or destroy files an unsettled child may still use.
  if (checkError === undefined && cleanupProblems.length === 0 && settled !== undefined
    && settled.childrenRemaining === 0 && settled.problems.length === 0) {
    rmSync(base, { recursive: true, force: true });
  } else {
    log(`self-check evidence retained at ${base}`);
  }
  for (const problem of cleanupProblems) log(`cleanup problem: ${problem}`);
  for (const problem of settled?.problems ?? []) log(`owner cleanup problem: ${problem}`);
  // A failed check surfaces as a failure even though cleanup already ran.
  if (checkError !== undefined) throw checkError;
  assert.ok(settled !== undefined, "the owner teardown must have run before any PASS");
  assert.equal(cleanupProblems.length, 0, "every owned resource was released without a cleanup problem");
  assert.equal(settled.childrenRemaining, 0, "every owned PTY child was confirmed exited");
  assert.deepEqual([...settled.problems], [], "the owner teardown reported no problems");
  log(`PASS (viewer proof callback ran ${proofCalls} time(s); owner viewer-role callbacks stayed at zero; owner evidence ${settled.evidenceDirectory})`);
  process.stdout.write("SELF_CHECK PASS\n");
}

main().catch((error: unknown) => {
  process.stdout.write(`SELF_CHECK FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
