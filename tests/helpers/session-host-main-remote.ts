/**
 * Test-only remote native content fixtures shared by the Main remote input/copy
 * suite and the remaining Main remote close/create/Saved cases.
 *
 * One owner for the controlled remote roster/viewport/input DTOs and the fake
 * content port. It imports the canonical base harness; no test case is
 * registered here and there is no second base harness or fake-state mirror.
 */
import assert from "node:assert/strict";

import type { ComposedHostFrame } from "../../src/session-host/compositor";
import type {
  PeerContentController,
  PeerContentObservation,
  PeerContentTarget,
  PeerContentViewport,
  PeerNativeCopyReceipt,
  PeerNativeInputRequest,
  PeerNativeInputTarget,
  PeerNativeIoCallbacks,
  PeerSelectedContent,
  PeerViewerNativeInputPolicy,
} from "../../src/session-host/network/peer-content";
import type { NativeInputSendResult } from "../../src/session-host/network/session-content-client";
import type {
  NativeIoInputSource,
  NativeIoSource,
  NativeIoStartupSource,
  SessionContentSnapshot,
} from "../../src/session-host/network/session-content-protocol";
import type { RemoteSessionMetadata } from "../../src/session-host/network/roster-metadata";
import type { PeerUiHost, PeerUiSnapshot } from "../../src/session-host/peer-ui-protocol";
import type { SidebarAction } from "../../src/session-host/sidebar";
import type { TerminalGraphicsFrame } from "../../src/session-host/kitty-graphics";
import type { TerminalInputModes } from "../../src/session-host/terminal-surface";

import {
  ALT_LEFT,
  ENTER,
  FakeManager,
  FakePeerCoordinator,
  fillForm,
  type Harness,
  type MainTestDependencies,
  nextTurn,
  peerMainHarness,
  plain,
  plainLine,
  selectedRosterHostLine,
} from "./session-host-main-harness";

// ---------------------------------------------------------------------------
// One selected remote native viewport in Main.
//
// The coordinator fake hands Main the already-landed content controller and
// publishes owner viewports through the callback Main itself supplied. Tuple
// facts are controlled DTOs; the existing harness uses owned filesystem
// fixtures and fake transport/children, never a real peer or physical clipboard.
// ---------------------------------------------------------------------------

export const REMOTE_INPUT_MODES: TerminalInputModes = {
  kittyFlags: 0,
  modifyOtherKeys: 0,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: false,
  mouseTracking: "none",
  mouseEncoding: "default",
};

/** Fixed notices the host shows for refused remote input (brief, non-modal). */
export const REMOTE_INPUT_NOT_SENT_NOTICE = "Remote input was refused; nothing was sent to the remote session";
export const REMOTE_INPUT_PASTE_TOO_LARGE_NOTICE = "That paste is larger than a remote session accepts; nothing was sent";
export const REMOTE_INPUT_UNCERTAIN_NOTICE =
  "UNCERTAIN: remote input may have been handed off; outcome unknown";
export const REMOTE_INPUT_VIEWER_OFF_NOTICE =
  "Remote input/copy is off for this viewer; nothing was sent to the remote session";

export function remoteRosterRow(overrides: Partial<RemoteSessionMetadata> & { id: string }): RemoteSessionMetadata {
  return {
    label: `remote-${overrides.id}`,
    workspace: `/remote/ws/${overrides.id}`,
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: null,
    pendingInput: null,
    inputSurface: false,
    activity: [],
    nativeSession: null,
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    ...overrides,
  };
}

export type RemotePeerUiHost = PeerUiHost & { roster: PeerUiHost["roster"] & { hostRunId?: string | null } };

export function remotePeerHost(options: {
  id: string;
  label?: string;
  hostRunId?: string | null;
  rows?: readonly RemoteSessionMetadata[] | null;
  rosterState?: "never" | "current" | "stale";
}): RemotePeerUiHost {
  return {
    id: options.id,
    label: options.label ?? `host-${options.id}`,
    host: "10.0.0.5",
    port: 8443,
    state: "connected",
    fingerprint: null,
    message: null,
    reconnectSuppressed: false,
    previouslyConnected: true,
    roster: {
      state: options.rosterState ?? "current",
      rows: options.rows ?? null,
      ...(options.hostRunId === undefined ? {} : { hostRunId: options.hostRunId }),
    },
  };
}

/** One complete owner-published native viewport: immutable metadata plus frame. */
export function remoteViewport(input: {
  subscriptionId: string;
  hostRunId: string;
  sessionId: string;
  sequence: number;
  cols: number;
  rows: number;
  revision?: number;
  marker: string;
  nativeSession?: { sessionId: string; epoch: number } | null;
  graphics?: TerminalGraphicsFrame;
  inputModes?: TerminalInputModes;
  inputSource?: NativeIoInputSource;
}): SessionContentSnapshot {
  return {
    meta: {
      subscriptionId: input.subscriptionId,
      transferId: `transfer-${input.sequence}`,
      hostRunId: input.hostRunId,
      sessionId: input.sessionId,
      nativeSession: input.nativeSession === undefined ? null : input.nativeSession,
      sequence: input.sequence,
      geometry: { cols: input.cols, rows: input.rows, revision: input.revision ?? 1 },
      inputModes: input.inputModes ?? REMOTE_INPUT_MODES,
      ...(input.inputSource === undefined ? {} : { inputSource: input.inputSource }),
      byteLength: 512,
      chunkCount: 1,
    },
    frame: {
      cols: input.cols,
      rows: input.rows,
      lines: Array.from({ length: input.rows }, (_unused, row) => row === 0 ? input.marker : ""),
      cursor: { column: 0, row: 0, visible: true },
      ...(input.graphics === undefined ? {} : { graphics: input.graphics }),
    },
  };
}

/**
 * One coherent host-written native source for a published remote viewport. Every
 * field is the owner's own fact; it is descriptive only and never authority.
 */
export function remoteNativeSource(input: {
  hostRunId: string;
  sessionId: string;
  nativeSession: { sessionId: string; epoch: number };
  cols: number;
  rows: number;
  revision?: number;
  viewerRevision?: number;
  sourceToken?: string;
}): NativeIoSource {
  return {
    hostRunId: input.hostRunId,
    sessionId: input.sessionId,
    nativeSession: { sessionId: input.nativeSession.sessionId, epoch: input.nativeSession.epoch },
    geometry: { cols: input.cols, rows: input.rows, revision: input.revision ?? 1 },
    viewerRevision: input.viewerRevision ?? 1,
    sourceToken: input.sourceToken ?? "commit-a",
  };
}

/**
 * The explicit tuple-less startup-phase source an owner publishes before its first
 * conversation tuple. It carries no `nativeSession` key at all: nothing here is a
 * fabricated conversation identity, and it is descriptive only, never authority.
 */
export function remoteStartupSource(input: {
  hostRunId: string;
  sessionId: string;
  cols: number;
  rows: number;
  revision?: number;
  viewerRevision?: number;
  sourceToken?: string;
}): NativeIoStartupSource {
  return {
    hostRunId: input.hostRunId,
    sessionId: input.sessionId,
    phase: "startup",
    geometry: { cols: input.cols, rows: input.rows, revision: input.revision ?? 1 },
    viewerRevision: input.viewerRevision ?? 1,
    sourceToken: input.sourceToken ?? "startup-a",
  };
}

/**
 * The content port the coordinator fake hands Main. It records Main's own
 * requests and publishes owner viewports the way the real controller does: one
 * global selection, one complete current view, one advisory callback.
 */
export class FakePeerContentPort implements PeerContentController {
  readonly selections: Array<PeerContentTarget | null> = [];
  readonly viewports: PeerContentViewport[] = [];
  readCalls = 0;
  selectThrows = false;
  /** Main's registered dynamic callbacks, when the internal opt-in supplied them. */
  nativeIo: PeerNativeIoCallbacks | undefined;
  /** Every input Main handed this port, including ones the proof refused. */
  readonly inputRequests: PeerNativeInputRequest[] = [];
  /** Inputs that passed both the admission proof and the pre-write re-proof. */
  readonly deliveredInputs: PeerNativeInputRequest[] = [];
  /** Outcome this fake endpoint reports for one accepted input. */
  sendResult: NativeInputSendResult = { status: "submitted" };
  /**
   * Scripted per-request outcomes (#500 burst cases). While entries remain they are
   * consumed in call order; once exhausted the single `sendResult` above resumes.
   */
  sendResults: NativeInputSendResult[] | undefined;
  rejectNextInput = false;
  /** State change between the admission proof and the pre-write re-proof. */
  beforeWrite: (() => void) | undefined;
  readNativeInputTargetCalls = 0;
  /**
   * This viewer's live Remote input/copy preference, exactly as the real
   * coordinator reports it: default ON, and every actual change advances the
   * generation (including an Off -> On return).
   */
  viewerPolicy: PeerViewerNativeInputPolicy = { enabled: true, generation: 1 };
  private changeHandler: ((observation: PeerContentObservation) => void) | undefined;

  readViewerNativeInputPolicy(): PeerViewerNativeInputPolicy {
    return this.viewerPolicy;
  }

  /** One actual preference change; a same-value call changes nothing. */
  setViewerInput(enabled: boolean): void {
    if (this.viewerPolicy.enabled === enabled) return;
    this.viewerPolicy = { enabled, generation: this.viewerPolicy.generation + 1 };
  }
  private observation: PeerContentObservation = { target: null, state: "none", view: undefined, reason: null };

  attach(onChange: ((observation: PeerContentObservation) => void) | undefined): void {
    this.changeHandler = onChange;
  }

  attachNativeIo(callbacks: PeerNativeIoCallbacks | undefined): void {
    this.nativeIo = callbacks;
  }

  /**
   * The descriptive target of the currently published view, exactly as the real
   * controller describes its own current endpoint. Descriptive only: it never
   * selects, rewrites, or authorizes anything.
   */
  readNativeInputTarget(): PeerNativeInputTarget | undefined {
    this.readNativeInputTargetCalls += 1;
    const target = this.observation.target;
    const view = this.observation.state === "current" ? this.observation.view : undefined;
    if (target === null || view === undefined) return undefined;
    const source = view.snapshot.meta.inputSource;
    if (source === undefined || source === null) return undefined;
    return {
      hostId: target.hostId,
      selectionGeneration: target.selectionGeneration,
      subscriptionId: view.snapshot.meta.subscriptionId,
      source,
      inputModes: view.snapshot.meta.inputModes,
    };
  }

  /**
   * Mirror the real coordinator/endpoint composition: the caller's dynamic proof
   * runs at admission AND immediately before the protected write, so a state
   * change between them refuses the write entirely.
   */
  sendNativeInput(request: PeerNativeInputRequest): Promise<NativeInputSendResult> {
    this.inputRequests.push(request);
    if (this.rejectNextInput) {
      this.rejectNextInput = false;
      return Promise.reject(new Error("synthetic input rejection"));
    }
    const target: PeerNativeInputTarget = {
      hostId: request.hostId,
      selectionGeneration: request.selectionGeneration,
      subscriptionId: request.subscriptionId,
      source: request.source,
      inputModes: request.inputModes,
    };
    const authorize = this.nativeIo?.authorizeInput;
    if (authorize === undefined || authorize(target) !== true) {
      return Promise.resolve({ status: "not-sent", reason: "unauthorized" });
    }
    try { this.beforeWrite?.(); } catch { /* a throwing hook is still just a state change */ }
    if (authorize(target) !== true) {
      return Promise.resolve({ status: "not-sent", reason: "unauthorized" });
    }
    if (this.sendResults !== undefined && this.sendResults.length > 0) {
      const outcome = this.sendResults.shift() as NativeInputSendResult;
      if (outcome.status !== "not-sent") this.deliveredInputs.push(request);
      return Promise.resolve(outcome);
    }
    if (this.sendResult.status !== "not-sent") this.deliveredInputs.push(request);
    return Promise.resolve(this.sendResult);
  }

  /** Deliver one completed copy through the callback Main registered, if any. */
  deliverCopy(receipt: PeerNativeCopyReceipt): void {
    this.nativeIo?.onCopy(receipt);
  }

  selectContent(target: PeerContentTarget | null): void {
    this.selections.push(target);
    if (this.selectThrows) throw new Error("synthetic selection failure");
    this.observation = target === null
      ? { target: null, state: "none", view: undefined, reason: null }
      : { target, state: "connecting", view: undefined, reason: null };
    this.changeHandler?.(this.observation);
  }

  updateContentViewport(viewport: PeerContentViewport): void {
    this.viewports.push(viewport);
  }

  readContent(): PeerContentObservation {
    this.readCalls += 1;
    return this.observation;
  }

  /** The exact selection Main last asked for. */
  currentTarget(): PeerContentTarget {
    const target = this.selections.at(-1);
    assert.ok(target, "Main asked the content port for exactly one selection");
    return target;
  }

  /** Publish one completed viewport as the port's current view and notify Main. */
  publish(snapshot: SessionContentSnapshot, patch: Partial<PeerContentObservation> = {}): void {
    const target = this.observation.target ?? this.selections.at(-1) ?? null;
    const view: PeerSelectedContent = {
      hostId: target?.hostId ?? "",
      selectionGeneration: target?.selectionGeneration ?? 0,
      snapshot,
    };
    this.observation = { target, state: "current", view, reason: null, ...patch };
    this.changeHandler?.(this.observation);
  }

  /** Deliver one observation without changing what the port itself holds. */
  deliver(observation: PeerContentObservation): void {
    this.changeHandler?.(observation);
  }
}

export class FakePeerCoordinatorWithContent extends FakePeerCoordinator {
  readonly content: PeerContentController;

  constructor(content: PeerContentController) {
    super();
    this.content = content;
  }
}

/** The peer Main harness plus the content controller the production factory returns. */
export async function remoteContentMainHarness(
  t: { after(callback: () => void): void },
  hosts: readonly RemotePeerUiHost[],
  dependencies: MainTestDependencies = {},
): Promise<{
  harness: Harness;
  peer: FakePeerCoordinatorWithContent;
  content: FakePeerContentPort;
  dispatch(action: SidebarAction): void;
}> {
  const content = new FakePeerContentPort();
  const peer = new FakePeerCoordinatorWithContent(content);
  const started = await peerMainHarness(t, undefined, dependencies, peer);
  content.attach(started.peer.options?.onContentChange);
  content.attachNativeIo(started.peer.options?.nativeIo);
  assert.ok(started.peer.options?.contentSource,
    "Main hands the one coordinator its own already-acquired owning-host service");
  started.peer.publish({ hosts: hosts as unknown as PeerUiSnapshot["hosts"] });
  await nextTurn();
  return { harness: started.harness, peer, content, dispatch: started.dispatch };
}

export function harnessManager(harness: Harness): FakeManager {
  assert.ok(harness.manager, "the harness manager is open after preflight");
  return harness.manager;
}

/** Text the compositor actually drew in the native pane of the wide layout. */
export function nativePaneText(frame: ComposedHostFrame | undefined): string {
  return frame?.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").slice(33)).join("\n") ?? "";
}

/** Exact visible status in these wide, banner-free fixtures: the host's own line, clipped to the pane. */
export function assertWideRemoteStatus(harness: Harness, message: string, description?: string): void {
  const cols = harness.terminal.columns - 33;
  assert.equal(
    plainLine(harness.writer.frames.at(-1)?.frame, 1).slice(33),
    message.slice(0, cols).padEnd(cols, " "),
    description,
  );
}

/** Activates the rendered remote card whose host line is selected, with real input. */
export async function activateRemoteRosterRow(harness: Harness, hostLabel: string): Promise<void> {
  for (let step = 0; step <= 16; step += 1) {
    const hostLine = selectedRosterHostLine(harness);
    if (hostLine.startsWith("  host ") && hostLine.includes(hostLabel)) {
      harness.terminal.emitInput(ENTER);
      await nextTurn();
      return;
    }
    harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail(`the actual rendered roster never offered its ${hostLabel} remote card`);
}

/**
 * The actual-written remote native IO scenario: one local row exists (so a local
 * fallback would be observable), one remote card is deliberately activated with
 * real host input, and one complete viewport carrying a coherent host-written
 * source is published and actually written. No dependency override is supplied:
 * the native IO bridge is the production default, and this viewer's Remote
 * input/copy preference starts On exactly as a new installation's does.
 */
export async function remoteNativeInputHarness(
  t: { after(callback: () => void): void },
): Promise<{
  harness: Harness;
  peer: FakePeerCoordinatorWithContent;
  content: FakePeerContentPort;
  manager: FakeManager;
  source: NativeIoSource;
  generation: number;
  rect: { readonly column: number; readonly row: number; readonly cols: number; readonly rows: number };
}> {
  const { harness, peer, content } = await remoteContentMainHarness(t, [
    remotePeerHost({
      id: "lab-a",
      label: "Lab Alpha",
      hostRunId: "run-a",
      rows: [remoteRosterRow({ id: "row-a", label: "Alpha remote" })],
    }),
  ]);
  const manager = harnessManager(harness);
  fillForm(harness.terminal, "/local/workspace");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  await activateRemoteRosterRow(harness, "Lab Alpha");
  const generation = content.currentTarget().selectionGeneration;
  const nativeSession = { sessionId: "conversation-a", epoch: 3 };
  const source = remoteNativeSource({
    hostRunId: "run-a", sessionId: "row-a", nativeSession, cols: 40, rows: 20,
  });
  content.publish(remoteViewport({
    subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 1,
    cols: 40, rows: 20, marker: "REMOTE-NATIVE-IO", nativeSession, inputSource: source,
  }));
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "main", "the written remote source owns Main focus");
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("REMOTE-NATIVE-IO"));
  // Wide layout: 32 sidebar columns plus one divider. The 40x20 frame is drawn at
  // the native pane's top-left corner, so everything past it is host padding.
  return { harness, peer, content, manager, source, generation, rect: { column: 33, row: 1, cols: 40, rows: 20 } };
}

/**
 * The same actual-written scenario BEFORE the owner reported any conversation
 * tuple: the selected remote row publishes a complete viewport whose native
 * conversation is null, carrying the explicit startup-phase source (for example
 * while native Pi asks whether to trust the project folder). Nothing here invents
 * a tuple, sends a status, or trusts anything on the operator's behalf.
 */
export async function remoteStartupInputHarness(
  t: { after(callback: () => void): void },
): Promise<{
  harness: Harness;
  peer: FakePeerCoordinatorWithContent;
  content: FakePeerContentPort;
  manager: FakeManager;
  startup: NativeIoStartupSource;
  generation: number;
}> {
  const { harness, peer, content } = await remoteContentMainHarness(t, [
    remotePeerHost({
      id: "lab-a",
      label: "Lab Alpha",
      hostRunId: "run-a",
      rows: [remoteRosterRow({ id: "row-a", label: "Alpha remote" })],
    }),
  ]);
  const manager = harnessManager(harness);
  fillForm(harness.terminal, "/local/workspace");
  await nextTurn();
  harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  await activateRemoteRosterRow(harness, "Lab Alpha");
  const generation = content.currentTarget().selectionGeneration;
  const startup = remoteStartupSource({ hostRunId: "run-a", sessionId: "row-a", cols: 40, rows: 20 });
  content.publish(remoteViewport({
    subscriptionId: "sub-a", hostRunId: "run-a", sessionId: "row-a", sequence: 1,
    cols: 40, rows: 20, marker: "REMOTE-STARTUP-TRUST", nativeSession: null, inputSource: startup,
  }));
  await nextTurn();
  assert.equal(harness.sidebar!.focus, "main", "the written startup source owns Main focus");
  assert.ok(plain(harness.writer.frames.at(-1)?.frame).includes("REMOTE-STARTUP-TRUST"),
    "the tuple-less startup viewport is displayed through the one writer");
  return { harness, peer, content, manager, startup, generation };
}

/** The coordinator's dynamic per-write proof Main supplied, for one exact expected source. */
export function remoteInputProof(
  content: FakePeerContentPort,
  generation: number,
  source: NativeIoInputSource,
  inputModes: TerminalInputModes = REMOTE_INPUT_MODES,
): boolean {
  const authorize = content.nativeIo?.authorizeInput;
  assert.ok(authorize, "the production default supplies the dynamic written-source proof");
  return authorize({ hostId: "lab-a", selectionGeneration: generation, subscriptionId: "sub-a", source, inputModes });
}
