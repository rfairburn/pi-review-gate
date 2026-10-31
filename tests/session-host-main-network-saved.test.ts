/**
 * Main's remote Saved browsing and its owner Saved provider.
 *
 * These cases exercise Main's own `saved-remote-*` admission through the shared
 * Main harness: the real owner Saved view Main hands its coordinator, the
 * actually-written picker frame a remote row must come from, identical repaint
 * versus resize or selection A -> B -> A re-admission, owner delete-exposure
 * changes at the queued write, one-request-per-owner read coalescing with the
 * exact query, and the fixed refusal when a coordinator has no Saved
 * controller. Fixtures are the canonical Main harness and remote-content fakes
 * plus controlled owner DTOs; no real peer, transport, saved conversation file,
 * native Pi child, or PTY is involved. A recorded "write" is only the fake
 * controller re-checking Main's own proof at its write boundary — never
 * acceptance by a physical native owner, a two-machine deployment, or an
 * operator.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  isOwnerSavedCatalogView,
  type OwnerSavedDeleteFacts,
  type OwnerSavedEntry,
  type OwnerSavedResumeFacts,
  type OwnerSavedWindowFacts,
  type PeerSavedController,
  type PeerSavedControllerOptions,
  type PeerSavedDeleteTarget,
  type PeerSavedListTarget,
  type PeerSavedResult,
  type PeerSavedResumeTarget,
  type PeerSavedSearchTarget,
  type PeerSavedWindowTarget,
} from "../src/session-host/network/peer-saved";
import type { PeerContentController } from "../src/session-host/network/peer-content";
import type { RemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import type { SidebarAction } from "../src/session-host/sidebar";
import type { OwningHostService } from "../src/session-host/owning-host-service";

import {
  ENTER,
  type FakePeerCoordinator,
  type Harness,
  type MainTestDependencies,
  closeWithSignal,
  nextTurn,
  peerMainHarness,
  plain,
} from "./helpers/session-host-main-harness";
import {
  FakePeerContentPort,
  FakePeerCoordinatorWithContent,
  harnessManager,
  remotePeerHost,
} from "./helpers/session-host-main-remote";

// ---------------------------------------------------------------------------
// Remote Saved history (Main's `saved-remote-*` wiring and owner provider).
//
// The coordinator fake exposes ONE Saved controller that records every METHOD
// invocation separately from the protected write it would perform: like the
// real raw viewer, it evaluates Main's own proof at admission and again
// immediately before its write, and only a write that passed that second proof
// counts. Owner facts are controlled DTOs; no real peer, file, or native child.
// ---------------------------------------------------------------------------

const REMOTE_SAVED_UNWRITTEN = "That Saved list is not the displayed list; nothing was sent";
const REMOTE_SAVED_MISSING = "This host cannot browse another host's Saved history; nothing was requested";
const REMOTE_SAVED_NOT_SENT = "That host is not ready or no longer addressable; nothing was sent";
const REMOTE_SAVED_UNCERTAIN = "UNCERTAIN: the remote request may have been handed off; outcome unknown";

type FakeSavedMethod = "list" | "search" | "window" | "resume" | "remove";

interface FakeSavedCall {
  readonly method: FakeSavedMethod;
  readonly target: Readonly<Record<string, unknown>>;
  readonly options: PeerSavedControllerOptions;
  /** Main's proof held when the method was invoked. */
  admitted: boolean;
  /** The protected write happened: Main's proof held again at the write boundary. */
  written: boolean;
  release: () => void;
}

class FakeSavedController implements PeerSavedController {
  readonly calls: FakeSavedCall[] = [];
  /** While true, every new call waits for its own release before the write. */
  hold = false;
  /** The owner's FULL result total; windows are honest slices of it. */
  total = 3;
  resumeResult: (target: PeerSavedResumeTarget) => PeerSavedResult<OwnerSavedResumeFacts>
    | Promise<PeerSavedResult<OwnerSavedResumeFacts>> = (target) => ({
    kind: "owner-result",
    outcome: { kind: "started", hostRunId: target.hostRunId, rowId: "row-resumed" },
  });
  prepareResult: PeerSavedResult<OwnerSavedDeleteFacts> = {
    kind: "owner-result", outcome: { kind: "confirmation-required" },
  };
  deleteResult: PeerSavedResult<OwnerSavedDeleteFacts> = {
    kind: "owner-result", outcome: { kind: "deleted", method: "trash" },
  };

  of(method: FakeSavedMethod): FakeSavedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  get writes(): number {
    return this.calls.filter((call) => call.written).length;
  }

  private async run<T>(
    method: FakeSavedMethod,
    target: object,
    options: PeerSavedControllerOptions,
    respond: () => PeerSavedResult<T> | Promise<PeerSavedResult<T>>,
  ): Promise<PeerSavedResult<T>> {
    const call: FakeSavedCall = {
      method, target: { ...target }, options, admitted: false, written: false, release: () => {},
    };
    this.calls.push(call);
    call.admitted = options.stillCurrent() === true;
    if (!call.admitted) return { kind: "not-sent", reason: "target-unavailable" };
    if (this.hold) await new Promise<void>((resolve) => { call.release = resolve; });
    if (options.stillCurrent() !== true) return { kind: "not-sent", reason: "target-unavailable" };
    call.written = true;
    return respond();
  }

  private windowOf(
    target: { readonly hostRunId: string; readonly offset: number; readonly count: number; readonly catalogId?: string },
    resultId: string,
  ): PeerSavedResult<OwnerSavedWindowFacts> {
    const entries: OwnerSavedEntry[] = [];
    for (let index = target.offset; index < Math.min(this.total, target.offset + target.count); index += 1) {
      entries.push({
        entryId: `e-${index}`,
        sessionId: `owner-session-${index}`,
        file: `/owner/sessions/${index}.jsonl`,
        caption: `owner caption ${index}`,
        cwd: `/owner/ws/${index}`,
      });
    }
    return {
      kind: "owner-result",
      outcome: {
        kind: "window", hostRunId: target.hostRunId, catalogId: target.catalogId ?? "cat-1", resultId,
        total: this.total, issueCount: 0, offset: target.offset, entries,
      },
    };
  }

  list(target: PeerSavedListTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedWindowFacts>> {
    return this.run("list", target, options, () => this.windowOf(target, "res-1"));
  }

  search(target: PeerSavedSearchTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedWindowFacts>> {
    return this.run("search", target, options, () => this.windowOf(target, `res-q-${this.calls.length}`));
  }

  window(target: PeerSavedWindowTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedWindowFacts>> {
    return this.run("window", target, options, () => this.windowOf(target, target.resultId));
  }

  resume(target: PeerSavedResumeTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedResumeFacts>> {
    return this.run("resume", target, options, () => this.resumeResult(target));
  }

  remove(target: PeerSavedDeleteTarget, options: PeerSavedControllerOptions): Promise<PeerSavedResult<OwnerSavedDeleteFacts>> {
    return this.run("remove", target, options, () => target.confirmed ? this.deleteResult : this.prepareResult);
  }
}

class FakePeerCoordinatorWithSaved extends FakePeerCoordinatorWithContent {
  readonly ownerSaved: FakeSavedController;

  constructor(content: PeerContentController, saved: FakeSavedController) {
    super(content);
    this.ownerSaved = saved;
  }
}

/** One connected Saved-capable destination with an observed owner run. */
function savedCapableHost(options: {
  readonly hostRunId?: string;
  readonly deleteExposed?: boolean | null;
  readonly rows?: readonly RemoteSessionMetadata[];
} = {}): PeerUiHost {
  return {
    ...remotePeerHost({ id: "lab-a", label: "Lab Alpha", hostRunId: options.hostRunId ?? "run-a", rows: options.rows ?? [] }),
    saved: { supported: true, deleteExposed: options.deleteExposed === undefined ? true : options.deleteExposed },
  } as PeerUiHost;
}

async function remoteSavedMainHarness(
  t: { after(callback: () => void): void },
  options: { readonly withController?: boolean; readonly dependencies?: MainTestDependencies } = {},
): Promise<{
  harness: Harness;
  peer: FakePeerCoordinator;
  content: FakePeerContentPort;
  saved: FakeSavedController;
  localListings: Array<Record<string, unknown>>;
  dispatch(action: SidebarAction): void;
}> {
  const content = new FakePeerContentPort();
  const saved = new FakeSavedController();
  const peer = options.withController === false
    ? new FakePeerCoordinatorWithContent(content)
    : new FakePeerCoordinatorWithSaved(content, saved);
  const localListings: Array<Record<string, unknown>> = [];
  const started = await peerMainHarness(t, undefined, {
    // Main's ONE listing dependency. Local listings are recorded and refused so
    // nothing reaches a real SDK; the owner view's own listings are recorded too.
    listSavedCatalog: async (listOptions) => {
      localListings.push({ ...listOptions });
      throw new Error("synthetic listing unavailable");
    },
    ...options.dependencies,
  }, peer);
  content.attach(started.peer.options?.onContentChange);
  started.harness.terminal.setSize(120, 30);
  await nextTurn();
  peer.publish({ hosts: [savedCapableHost()] as unknown as PeerUiSnapshot["hosts"] });
  await nextTurn();
  return { harness: started.harness, peer, content, saved, localListings, dispatch: started.dispatch };
}

/** Opens Saved (Local), then chooses the one remote owner through the Host line. */
async function openRemoteSavedPicker(harness: Harness): Promise<void> {
  harness.terminal.emitInput("\x1b[A"); // New session -> Saved conversations
  await nextTurn();
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "form", "the Saved picker owns the pane");
  assert.equal(harness.sidebar!.savedPickerHost.kind, "local", "every opening starts on Local");
  harness.terminal.emitInput("\x1b[Z"); // Shift+Tab: the picker's Host line
  await nextTurn();
  harness.terminal.emitInput("\x1b[B"); // Local -> Lab Alpha
  await nextTurn();
  harness.terminal.emitInput("\x1b[Z"); // back to the query
  await nextTurn();
  assert.equal(harness.sidebar!.savedPickerHost.kind, "remote");
}

function savedRunId(peer: FakePeerCoordinator): string {
  const service = peer.options?.contentSource as unknown as OwningHostService | undefined;
  const runId = service?.readInventorySnapshot()?.hostRunId;
  assert.ok(typeof runId === "string" && runId.length > 0, "the owner run is observable");
  return runId;
}

test("Main hands the coordinator its real owner Saved view and the requester opt-in, independent of native input", async (t) => {
  for (const nativeInputOriginFraming of [undefined, false] as const) {
    const { harness, peer, localListings } = await remoteSavedMainHarness(t, {
      dependencies: nativeInputOriginFraming === undefined ? {} : { nativeInputOriginFraming },
    });
    try {
      const options = peer.options;
      assert.ok(options);
      assert.equal(options.savedViewer, true, "the requester Saved controller is armed");
      assert.equal(typeof options.savedCatalogViewFactory, "function", "the owner Saved provider is supplied");
      assert.equal(options.nativeIo === undefined, nativeInputOriginFraming === false,
        "native input framing is decided separately from Saved");
      assert.equal(harness.events.filter((name) => name === "manager.create").length, 1,
        "no second manager exists");
      assert.deepEqual(localListings, [] as typeof localListings, "handing over the factory lists nothing");

      const view = options.savedCatalogViewFactory!();
      assert.equal(isOwnerSavedCatalogView(view), true, "the factory builds the real native view");
      const facts = await view.list(
        { hostRunId: savedRunId(peer), query: "", offset: 0, count: 8 },
        new AbortController().signal,
        () => true,
      );
      assert.deepEqual(facts, { kind: "unavailable" }, "a refused native listing is reported as unavailable");
      assert.equal(localListings.length, 1, "the owner view used Main's one listing dependency");
      const listing = localListings[0]!;
      assert.equal(typeof listing.agentDir, "string", "the actual native agent directory of this host");
      assert.equal(listing.piExecutable, "/synthetic/pi", "the actual resolved Pi executable");
      assert.equal(listing.expectedPiVersion, "1.0.4", "the actual admitted Pi version");
      assert.ok(listing.signal instanceof AbortSignal, "a real abort signal is required");
      assert.equal(typeof listing.freshnessScope, "object", "the owner view lists under its own freshness scope");
      assert.equal("listAll" in listing, false, "no injected listing bypass reaches the dependency");
      view.dispose();
    } finally {
      assert.equal(await closeWithSignal(harness), 0);
    }
  }
});

test("a written remote Saved row resumes exactly once on its owner and selects the started owner row", async (t) => {
  const { harness, saved, content, localListings } = await remoteSavedMainHarness(t);
  const manager = harnessManager(harness);
  try {
    await openRemoteSavedPicker(harness);
    assert.equal(localListings.length, 1, "the Local opening listed Local once");
    assert.equal("freshnessScope" in localListings[0]!, false, "the Local picker keeps the default freshness domain");
    const list = saved.of("list");
    assert.equal(list.length, 1, "choosing the owner asks it for exactly one listing");
    assert.deepEqual(Object.keys(list[0]!.target).sort(), ["count", "hostId", "hostRunId", "offset", "query"],
      "the request is a closed copy: no picker/request ids or display text travel");
    assert.equal(list[0]!.target.query, "");
    assert.equal(list[0]!.target.hostRunId, "run-a");
    const text = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(text.includes("owner caption 0"), "the owner's rows are drawn with the shared formatter");
    assert.ok(text.includes("/owner/ws/0"), "with the owner's exact recorded workspace");

    harness.terminal.emitInput(ENTER);
    harness.terminal.emitInput("\x1b[13;1:2u"); // the held Enter's repeat
    await nextTurn();
    const resume = saved.of("resume");
    assert.equal(resume.length, 1, "exactly one Resume; the held repeat never resends");
    assert.deepEqual(resume[0]!.target, {
      hostId: "lab-a", hostRunId: "run-a", catalogId: "cat-1", resultId: "res-1", entryId: "e-0",
    }, "only the exact owner run and opaque owner handles are named");
    assert.equal(resume[0]!.written, true, "the protected write passed Main's queued proof");
    const target = content.currentTarget();
    assert.deepEqual({ hostId: target.hostId, hostRunId: target.hostRunId, rowId: target.rowId },
      { hostId: "lab-a", hostRunId: "run-a", rowId: "row-resumed" }, "the owner's started row is selected");
    assert.equal(harness.sidebar!.focus, "main");
    assert.deepEqual(manager.createOptions, [], "no LOCAL child is ever started for a remote Resume");
    assert.deepEqual(content.inputRequests, [], "the native input scope is never used for Saved");
    assert.equal(localListings.length, 1, "no Local catalog work happens for remote rows");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("an owner-started Resume row this side has not observed yet is pending, never unavailable", async (t) => {
  const { harness, content } = await remoteSavedMainHarness(t);
  try {
    await openRemoteSavedPicker(harness);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    const target = content.currentTarget();
    content.deliver({ target, state: "unavailable", view: undefined, reason: "row-unavailable" });
    await nextTurn();
    const text = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(text.includes("Waiting for the new remote session in its host's roster"),
      "the staged owner row reuses the existing awaiting path");
    assert.equal(text.includes("The selected remote session's display is unavailable"), false);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("an unwritten picker frame sends no remote Resume, even for a forged intent", async (t) => {
  const { harness, saved, dispatch } = await remoteSavedMainHarness(t);
  try {
    await openRemoteSavedPicker(harness);
    harness.writer.holdWrites = true;
    harness.terminal.emitInput("\x1b[B"); // a new selection: a new frame that is only held
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(saved.of("resume"), [], "a held frame is never a receipt");
    const drawn = harness.sidebar!.captureSavedPickerPresentation();
    assert.ok(drawn !== undefined);
    dispatch({
      type: "saved-remote-resume", pickerId: drawn.pickerId, requestId: 900_000, revision: drawn.revision,
      hostId: drawn.hostId, hostRunId: drawn.hostRunId, catalogId: drawn.catalogId, resultId: drawn.resultId,
      entryId: "e-1", renderToken: drawn.renderToken,
    });
    await nextTurn();
    assert.deepEqual(saved.of("resume"), [], "Main's own written-receipt admission refuses it too");

    harness.writer.drainHeldWrites();
    await nextTurn();
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(saved.of("resume").length, 1, "the actually written frame resumes");
    assert.equal(saved.of("resume")[0]!.target.entryId, "e-1");
  } finally {
    harness.writer.holdWrites = false;
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("an admitted Resume survives an identical repaint but never a resize or selection A -> B -> A", async (t) => {
  const { harness, peer, saved, content } = await remoteSavedMainHarness(t);
  const manager = harnessManager(harness);
  try {
    await openRemoteSavedPicker(harness);
    saved.hold = true;
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(saved.of("resume")[0]?.admitted, true);
    // Ordinary unrelated roster/snapshot activity repaints the same semantic source.
    manager.notify("unrelated-local-change");
    peer.publish({ hosts: [savedCapableHost()] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    saved.hold = false;
    saved.of("resume")[0]!.release();
    await nextTurn();
    assert.equal(saved.of("resume")[0]!.written, true, "a harmless repaint never stalls an admitted Resume");
    assert.equal(content.selections.length, 1);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }

  for (const change of ["resize", "selection"] as const) {
    const run = await remoteSavedMainHarness(t);
    try {
      await openRemoteSavedPicker(run.harness);
      run.saved.hold = true;
      run.harness.terminal.emitInput(ENTER);
      await nextTurn();
      assert.equal(run.saved.of("resume")[0]?.admitted, true);
      if (change === "resize") {
        run.harness.terminal.setSize(100, 30);
        await nextTurn();
        run.harness.terminal.setSize(120, 30);
      } else {
        run.harness.terminal.emitInput("\x1b[B");
        await nextTurn();
        run.harness.terminal.emitInput("\x1b[A");
      }
      await nextTurn();
      run.saved.hold = false;
      run.saved.of("resume")[0]!.release();
      await nextTurn();
      assert.equal(run.saved.of("resume")[0]!.written, false, `a ${change} A -> B -> A never revives the admission`);
      assert.deepEqual(run.content.selections, [], "nothing is selected");
      assert.equal(run.harness.sidebar!.focus, "form");
      assert.ok(plain(run.harness.writer.frames.at(-1)?.frame).includes(REMOTE_SAVED_NOT_SENT),
        "the positive not-sent outcome is reported truthfully");
      assert.equal(run.saved.of("resume").length, 1, "nothing is retried");
    } finally {
      assert.equal(await closeWithSignal(run.harness), 0);
    }
  }
});

test("an unknown Resume outcome is reported as uncertain and never retried", async (t) => {
  const { harness, saved, content } = await remoteSavedMainHarness(t);
  try {
    await openRemoteSavedPicker(harness);
    saved.resumeResult = () => ({ kind: "unknown" });
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    await nextTurn();
    assert.equal(saved.of("resume").length, 1, "zero automatic retries");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes(REMOTE_SAVED_UNCERTAIN));
    assert.deepEqual(content.selections, []);
    assert.equal(harness.sidebar!.focus, "form");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("late remote Resume outcomes remain visible without reclaiming focus or selection", async (t) => {
  const cases: readonly { result: PeerSavedResult<OwnerSavedResumeFacts>; notice: string }[] = [
    { result: { kind: "unknown" }, notice: "UNCERTAIN:" },
    { result: { kind: "owner-result", outcome: { kind: "unknown" } }, notice: "UNCERTAIN:" },
    { result: { kind: "owner-result", outcome: { kind: "unconfirmed" } }, notice: "The remote host could not" },
    { result: { kind: "owner-result", outcome: { kind: "started", hostRunId: "run-a", rowId: "late-row" } },
      notice: "Remote conversation resumed" },
  ];
  for (const { result, notice } of cases) {
    const { harness, saved, content } = await remoteSavedMainHarness(t);
    let complete!: (result: PeerSavedResult<OwnerSavedResumeFacts>) => void;
    const reply = new Promise<PeerSavedResult<OwnerSavedResumeFacts>>((resolve) => { complete = resolve; });
    saved.resumeResult = () => reply;
    try {
      await openRemoteSavedPicker(harness);
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      assert.equal(saved.of("resume").length, 1);
      assert.equal(saved.of("resume")[0]!.written, true, "the request was handed off before dismissal");
      harness.terminal.emitInput("\x1b");
      await nextTurn();
      assert.equal(harness.sidebar!.savedRemoteContext(), undefined, "the picker really is dismissed");
      const focus = harness.sidebar!.focus;
      const selections = [...content.selections];
      complete(result);
      await nextTurn();
      assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes(notice),
        "a completed or uncertain late Resume is reported by a fixed notice");
      assert.equal(harness.sidebar!.focus, focus, "late truth never reclaims focus");
      assert.deepEqual(content.selections, selections, "late truth never selects the owner row");
      assert.equal(saved.of("resume").length, 1, "the request is never re-sent");
      assert.deepEqual(harnessManager(harness).createOptions, [], "nothing starts on the requester");
    } finally {
      complete(result);
      assert.equal(await closeWithSignal(harness), 0);
    }
  }
});

test("a confirmed remote Delete is admitted from the written dialog and survives an identical repaint", async (t) => {
  const { harness, peer, saved } = await remoteSavedMainHarness(t);
  const manager = harnessManager(harness);
  try {
    await openRemoteSavedPicker(harness);
    harness.terminal.emitInput("\x04"); // ctrl+d: owner prepare only
    await nextTurn();
    const prepare = saved.of("remove");
    assert.equal(prepare.length, 1);
    assert.deepEqual(prepare[0]!.target, {
      hostId: "lab-a", hostRunId: "run-a", catalogId: "cat-1", resultId: "res-1", entryId: "e-0", confirmed: false,
    });
    assert.equal(harness.sidebar!.focus, "confirm", "the owner's confirmation-required opens the Local-style dialog");
    const dialog = plain(harness.writer.frames.at(-1)?.frame);
    assert.ok(dialog.includes("Delete saved conversation?"));
    assert.ok(dialog.includes("Saved file: /owner/sessions/0.jsonl"), "the full owner file path is shown");
    assert.ok(dialog.includes("Host: Lab Alpha"));

    saved.hold = true;
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    const confirmed = saved.of("remove")[1];
    assert.ok(confirmed !== undefined && confirmed.admitted);
    assert.equal(confirmed.target.confirmed, true);
    // Every dialog render re-mints its token; an identical repaint must not kill it.
    manager.notify("unrelated-local-change");
    peer.publish({ hosts: [savedCapableHost()] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    saved.hold = false;
    confirmed.release();
    await nextTurn();
    assert.equal(confirmed.written, true, "the queued delete was written after a harmless repaint");
    assert.equal(saved.of("remove").length, 2, "a confirmed delete is sent exactly once");
    assert.equal(harness.sidebar!.focus, "form");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Saved conversation moved to trash"));
    assert.equal(saved.of("list").length, 2, "a deletion relists the owner catalog as a new read");
    assert.deepEqual(manager.createOptions, []);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("owner delete exposure Off -> On wholly before the queued write permits the still-owned confirmed Delete", async (t) => {
  const { harness, peer, saved } = await remoteSavedMainHarness(t);
  try {
    await openRemoteSavedPicker(harness);
    harness.terminal.emitInput("\x04");
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "confirm");
    saved.hold = true;
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    const confirmed = saved.of("remove")[1];
    assert.ok(confirmed !== undefined && confirmed.admitted);
    peer.publish({ hosts: [savedCapableHost({ deleteExposed: false })] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    peer.publish({ hosts: [savedCapableHost({ deleteExposed: true })] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    saved.hold = false;
    confirmed.release();
    await nextTurn();
    assert.equal(confirmed.written, true, "current On permits the original queued delete without a fresh confirmation");
    assert.equal(saved.of("remove").length, 2, "nothing is retried");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Saved conversation moved to trash"));
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("latest owner exposure Off at the queued write blocks Delete and later On never replays it", async (t) => {
  const { harness, peer, saved } = await remoteSavedMainHarness(t);
  try {
    await openRemoteSavedPicker(harness);
    harness.terminal.emitInput("\x04");
    await nextTurn();
    assert.equal(harness.sidebar!.focus, "confirm");
    saved.hold = true;
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    const confirmed = saved.of("remove")[1];
    assert.ok(confirmed !== undefined && confirmed.admitted);
    peer.publish({ hosts: [savedCapableHost({ deleteExposed: false })] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    saved.hold = false;
    confirmed.release();
    await nextTurn();
    assert.equal(confirmed.written, false, "current Off refuses before the transport");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes(REMOTE_SAVED_NOT_SENT));
    peer.publish({ hosts: [savedCapableHost()] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    assert.equal(saved.of("remove").length, 2, "later On never retries or reopens the failed attempt");
    assert.equal(harness.sidebar!.focus, "form");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a prepare queued across owner Off -> On still opens its exact confirmation", async (t) => {
  const { harness, peer, saved } = await remoteSavedMainHarness(t);
  try {
    await openRemoteSavedPicker(harness);
    saved.hold = true;
    harness.terminal.emitInput("\x04");
    await nextTurn();
    const prepare = saved.of("remove")[0];
    assert.ok(prepare !== undefined && prepare.admitted);
    peer.publish({ hosts: [savedCapableHost({ deleteExposed: false })] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    peer.publish({ hosts: [savedCapableHost()] as unknown as PeerUiSnapshot["hosts"] });
    await nextTurn();
    saved.hold = false;
    prepare.release();
    await nextTurn();
    assert.equal(prepare.written, true);
    assert.equal(harness.sidebar!.focus, "confirm");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Saved file: /owner/sessions/0.jsonl"));
    assert.equal(saved.of("remove").length, 1, "the original prepare was not retried");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("another destination's delete exposure changes never refuse this owner's prepare or queued Delete", async (t) => {
  const { harness, peer, saved } = await remoteSavedMainHarness(t);
  const otherHost = (deleteExposed: boolean, state: PeerUiHost["state"] = "connected"): PeerUiHost => ({
    ...remotePeerHost({ id: "lab-b", label: "Lab Beta", hostRunId: "run-b", rows: [] }),
    state,
    saved: { supported: true, deleteExposed },
  } as PeerUiHost);
  const publish = (...hosts: PeerUiHost[]): void => {
    peer.publish({ hosts: hosts as unknown as PeerUiSnapshot["hosts"] });
  };
  try {
    publish(savedCapableHost(), otherHost(true));
    await nextTurn();
    await openRemoteSavedPicker(harness);
    const chosen = harness.sidebar!.savedPickerHost;
    assert.equal(chosen.kind === "remote" ? chosen.hostId : undefined, "lab-a", "the picker names owner A");

    // A Delete-prepare to A is in flight while B turns its exposure Off.
    saved.hold = true;
    harness.terminal.emitInput("\x04");
    await nextTurn();
    const prepare = saved.of("remove")[0];
    assert.ok(prepare !== undefined && prepare.admitted);
    publish(savedCapableHost(), otherHost(false));
    await nextTurn();
    saved.hold = false;
    prepare.release();
    await nextTurn();
    assert.equal(prepare.written, true, "B's policy change does not refuse A's prepare");
    assert.equal(harness.sidebar!.focus, "confirm", "A's confirmation opens");

    // A confirmed Delete to A is held while B turns On, disconnects, and vanishes.
    saved.hold = true;
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    const confirmed = saved.of("remove")[1];
    assert.ok(confirmed !== undefined && confirmed.admitted && confirmed.target.confirmed === true);
    publish(savedCapableHost(), otherHost(true));
    await nextTurn();
    publish(savedCapableHost(), otherHost(true, "disconnected"));
    await nextTurn();
    publish(savedCapableHost());
    await nextTurn();
    saved.hold = false;
    confirmed.release();
    await nextTurn();
    assert.equal(confirmed.written, true, "unrelated destinations never kill A's legitimate queued Delete");
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("Saved conversation moved to trash"));
    assert.equal(saved.of("remove").length, 2, "exactly one prepare and one confirmed delete");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("remote reads keep one request per owner and only the newest unsent read, with the exact query", async (t) => {
  const { harness, saved } = await remoteSavedMainHarness(t);
  try {
    saved.hold = true;
    await openRemoteSavedPicker(harness);
    assert.equal(saved.calls.length, 1, "the first listing is in flight");
    const typed = "x  spaced ünï 文字  ";
    for (const character of [...typed]) {
      harness.terminal.emitInput(character);
      await nextTurn();
    }
    assert.equal(saved.calls.length, 1, "nothing more is handed to a destination with a request in flight");
    assert.equal(harness.sidebar!.savedRemoteContext()?.pendingReads.length, 1, "no unbounded read state");

    saved.calls[0]!.release();
    await nextTurn();
    assert.equal(saved.calls[0]!.written, false, "the superseded listing never writes");
    assert.equal(saved.calls.length, 2, "the newest unsent read is dispatched exactly once");
    assert.equal(saved.calls[1]!.method, "list");
    assert.equal(saved.calls[1]!.target.query, typed, "the query is forwarded verbatim");

    saved.hold = false;
    saved.calls[1]!.release();
    await nextTurn();
    assert.equal(saved.calls[1]!.written, true);
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("owner caption 0"));
    assert.equal(saved.calls.length, 2, "no follow-up for a fully cached result");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a coordinator without the Saved controller refuses remote Saved with a fixed notice and no Local fallback", async (t) => {
  const { harness, localListings } = await remoteSavedMainHarness(t, { withController: false });
  const manager = harnessManager(harness);
  try {
    await openRemoteSavedPicker(harness);
    assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes(REMOTE_SAVED_MISSING));
    assert.equal(localListings.length, 1, "only the Local opening listed anything");
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(manager.createOptions, [], "nothing local is started");
    assert.equal(plain(harness.writer.frames.at(-1)?.frame).includes(REMOTE_SAVED_UNWRITTEN), false,
      "no row was ever drawn, so nothing could be acted on");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});
