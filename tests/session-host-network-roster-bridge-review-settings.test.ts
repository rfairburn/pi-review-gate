/**
 * Paired bridge tests for the optional Review-settings exchange (#716 transport
 * slice). The loopback channel preserves message boundaries exactly as the real
 * WebSocket does; no socket, process, file, or settings module is touched.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { NativeInstanceView } from "../src/session-host/instances";
import type {
  OwningHostInventoryListener,
  OwningHostInventorySnapshot,
  OwningHostInventoryWatch,
} from "../src/session-host/owning-host-service";
import type { PeerByteChannel, PeerChannelClose } from "../src/session-host/network/channel";
import { attachRosterBridgeViewer } from "../src/session-host/network/roster-bridge-client";
import { createRosterBridgeHost, type RosterBridgeHostOptions } from "../src/session-host/network/roster-bridge-host";
import {
  REVIEW_SETTINGS_MAX_BYTES,
  REVIEW_SETTINGS_MAX_CHUNKS,
  REVIEW_SETTINGS_EMPTY_SHA256,
  REVIEW_SETTINGS_FRAGMENT_BYTES,
  encodeReviewSettingsEnvelope,
  type OwnerReviewSettingsFacts,
  type OwnerReviewSettingsPolicy,
  type OwnerReviewSettingsPolicyState,
  type OwnerReviewSettingsRequest,
  type OwnerReviewSettingsHandler,
} from "../src/session-host/network/peer-review-settings";
import type {
  OwnerSavedCatalogView,
  OwnerSavedEntry,
} from "../src/session-host/network/peer-saved";
import type { OwnerCloseFacts } from "../src/session-host/network/peer-close";
import {
  ROSTER_BRIDGE_MAJOR,
  ROSTER_BRIDGE_MINOR,
  ROSTER_BRIDGE_REQUIRED_CAPABILITY,
  ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY,
  ROSTER_BRIDGE_SERVICE,
  ROSTER_BRIDGE_SAVED_CAPABILITY,
  decodeRosterBridgeFrame,
  encodeRosterBridgeFrame,
  type RosterBridgeFrame,
  type RosterBridgeHelloFrame,
  type RosterBridgeReviewSettingsChunkFrame,
  type RosterBridgeReviewSettingsEndFrame,
  type RosterBridgeBounds,
} from "../src/session-host/network/roster-bridge-protocol";

const RUN = "review-run";
const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(value));
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

function nativeSession(id: string) {
  return { sessionId: `conversation-${id}`, epoch: 2, name: `Conversation ${id}` };
}

function ownerRow(id: string): NativeInstanceView {
  return {
    id,
    label: `Row ${id}`,
    workspace: `/owner/work-${id}`,
    agentDir: "/owner/.pi/agent",
    lifecycle: "alive",
    busy: null,
    pendingInput: null,
    inputSurface: false,
    nativeSession: nativeSession(id),
    backgroundTasks: null,
    backgroundShells: null,
    activeTasks: null,
    activeShells: null,
    hasLiveProcess: true,
    activity: [],
    lastNativeSession: nativeSession(id),
  } as NativeInstanceView & { lastNativeSession?: unknown };
}

function savedEntries(count: number): OwnerSavedEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    entryId: `entry-${index}`,
    sessionId: `session-${index}`,
    file: `/saved/${index}.json`,
    caption: `Entry ${index}`,
    cwd: "/workspace",
  }));
}

function savedView(entries: readonly OwnerSavedEntry[]): OwnerSavedCatalogView {
  const window = async (request: {
    readonly hostRunId: string;
    readonly offset: number;
    readonly count: number;
  }) => ({
    kind: "window" as const,
    hostRunId: request.hostRunId,
    catalogId: "catalog-1",
    resultId: "result-1",
    total: entries.length,
    issueCount: 0,
    offset: request.offset,
    entries: entries.slice(request.offset, request.offset + request.count),
  });
  return {
    list: window,
    search: window,
    window,
    resume: async () => ({ kind: "unknown" as const }),
    remove: async () => ({ kind: "unknown" as const }),
    dispose: () => undefined,
  };
}

class Channel implements PeerByteChannel {
  readonly lane = "app";
  readonly label = "synthetic-loopback";
  readonly peerKey: { keyId: string; fingerprint: string };
  readonly bufferedAmount = 0;
  readonly sent: Buffer[] = [];
  readonly received: RosterBridgeFrame[] = [];
  peer!: Channel;
  intercept?: (frame: RosterBridgeFrame) => "drop" | "reject" | void;
  readonly #handlers = new Set<(bytes: Buffer) => void>();
  /** Hold owner replies until release(), so both transfer families can queue. */
  hold = false;
  #held: { bytes: Buffer; settle: () => void }[] = [];
  #done = false;
  #resolveClosed!: (value: PeerChannelClose) => void;
  readonly closed = new Promise<PeerChannelClose>((resolve) => {
    this.#resolveClosed = resolve;
  });

  constructor(peerKey: { keyId: string; fingerprint: string }) {
    this.peerKey = peerKey;
  }

  frames(): RosterBridgeFrame[] {
    return this.sent.map((bytes) => decodeRosterBridgeFrame(bytes));
  }

  types(): string[] {
    return this.frames().map((frame) => frame.type);
  }

  send(bytes: Uint8Array): Promise<void> {
    if (this.#done) return Promise.reject(new Error("closed"));
    const copy = Buffer.from(bytes);
    const frame = decodeRosterBridgeFrame(copy);
    this.sent.push(copy);
    const disposition = this.intercept?.(frame);
    if (disposition === "reject") return Promise.reject(new Error("lost send"));
    if (disposition !== "drop" && this.hold) {
      return new Promise<void>((resolve) => {
        this.#held.push({ bytes: copy, settle: resolve });
      });
    }
    if (disposition !== "drop") {
      queueMicrotask(() => this.peer.deliver(Buffer.from(copy)));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    for (const side of [this, this.peer]) {
      if (!side.#done) {
        side.#done = true;
        const held = side.#held;
        side.#held = [];
        for (const entry of held) entry.settle();
        side.#resolveClosed({ code: 1000, reason: "test" });
      }
    }
    return Promise.resolve();
  }

  onMessage(handler: (bytes: Buffer) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  deliver(bytes: Buffer): void {
    if (this.#done) return;
    this.received.push(decodeRosterBridgeFrame(bytes));
    for (const handler of [...this.#handlers]) handler(bytes);
  }

  release(): void {
    const held = this.#held;
    this.#held = [];
    this.hold = false;
    for (const entry of held) {
      entry.settle();
      queueMicrotask(() => this.peer.deliver(Buffer.from(entry.bytes)));
    }
  }
}

interface Pair {
  readonly viewerSide: Channel;
  readonly ownerSide: Channel;
}

function pair(): Pair {
  // A channel reports the key of the peer on the other side.
  const viewerSide = new Channel({ keyId: "owner-key", fingerprint: "synthetic-owner" });
  const ownerSide = new Channel({ keyId: "viewer-key", fingerprint: "synthetic-viewer" });
  viewerSide.peer = ownerSide;
  ownerSide.peer = viewerSide;
  return { viewerSide, ownerSide };
}

class FakeInventory {
  hostRunId = RUN;
  revision = 0;
  rows: NativeInstanceView[] = [];
  readonly watches: { readonly listener: OwningHostInventoryListener; unsubscribed: number; snapshot: OwningHostInventorySnapshot }[] = [];

  watchInventory(listener: OwningHostInventoryListener): OwningHostInventoryWatch {
    const snapshot = this.#snapshot();
    const watch = {
      snapshot,
      listener,
      unsubscribed: 0,
      unsubscribe: () => {
        watch.unsubscribed += 1;
      },
    };
    this.watches.push(watch);
    return watch;
  }

  emit(): OwningHostInventorySnapshot {
    const snapshot = this.#snapshot();
    for (const watch of this.watches) if (watch.unsubscribed === 0) watch.listener(snapshot);
    return snapshot;
  }

  #snapshot(): OwningHostInventorySnapshot {
    this.revision += 1;
    return Object.freeze({
      hostRunId: this.hostRunId,
      revision: this.revision,
      rows: Object.freeze([...this.rows]),
    });
  }
}

const FAST_BOUNDS = {
  handshakeTimeoutMs: 300,
  snapshotStartTimeoutMs: 300,
  transferIdleTimeoutMs: 250,
  stopAckTimeoutMs: 120,
  helloTimeoutMs: 300,
  closeResultTimeoutMs: 200,
  createResultTimeoutMs: 220,
};

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function helloFrame(capabilities: readonly string[] = [ROSTER_BRIDGE_REQUIRED_CAPABILITY]): RosterBridgeHelloFrame {
  return {
    type: "hello",
    service: ROSTER_BRIDGE_SERVICE,
    major: ROSTER_BRIDGE_MAJOR,
    minor: ROSTER_BRIDGE_MINOR,
    capabilities,
  };
}

class ScriptedViewer {
  readonly channel: Channel;
  readonly received: RosterBridgeFrame[] = [];

  constructor(channel: Channel) {
    this.channel = channel;
    channel.onMessage((bytes) => {
      this.received.push(decodeRosterBridgeFrame(bytes));
    });
  }

  write(frame: RosterBridgeFrame): void {
    const bytes = encodeRosterBridgeFrame(frame);
    this.channel.sent.push(bytes);
    this.channel.peer.deliver(bytes);
  }

  hello(offer = true): void {
    this.write(helloFrame(offer
      ? [ROSTER_BRIDGE_REQUIRED_CAPABILITY, ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY]
      : [ROSTER_BRIDGE_REQUIRED_CAPABILITY]));
  }

  subscribe(id = "sub-review-settings"): void {
    this.write({ type: "subscribe", subscriptionId: id });
  }

  types(): string[] {
    return this.received.map((frame) => frame.type);
  }
}

interface HarnessOptions {
  readonly provider?: OwnerReviewSettingsHandler;
  readonly policy?: OwnerReviewSettingsPolicy;
  readonly offer?: boolean;
  /** Exact optional capability identifiers this viewer offers, when not the default set. */
  readonly offerCapabilities?: readonly string[];
  readonly authorize?: () => boolean;
  readonly rows?: readonly string[];
  readonly bounds?: Partial<RosterBridgeBounds>;
  readonly savedView?: OwnerSavedCatalogView;
  readonly close?: () => OwnerCloseFacts | Promise<OwnerCloseFacts>;
}

function harness(options: HarnessOptions = {}) {
  const channels = pair();
  const inventory = new FakeInventory();
  inventory.rows = (options.rows ?? []).map(ownerRow);
  const policies: (OwnerReviewSettingsPolicyState | undefined)[] = [];
  const ownerDiagnostics: string[] = [];
  const hostOptions: RosterBridgeHostOptions = {
    inventory,
    authorizePeer: options.authorize ?? (() => true),
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    onDiagnostic: (event) => ownerDiagnostics.push(event.code),
    ...(options.savedView === undefined
      ? {}
      : {
        savedCatalogView: () => options.savedView as OwnerSavedCatalogView,
        remoteHistoryDeleteExposed: () => false,
      }),
    ...(options.close === undefined
      ? {}
      : { closeOwnedSession: async () => options.close!() }),
    ...(options.provider === undefined && options.policy === undefined
      ? {}
      : {
        reviewSettingsProvider: options.provider as OwnerReviewSettingsHandler,
        remoteReviewSettingsExposed: options.policy as OwnerReviewSettingsPolicy,
      }),
  };
  const host = createRosterBridgeHost(hostOptions);
  const binding = host.attach(channels.ownerSide);
  const viewer = attachRosterBridgeViewer({
    channel: channels.viewerSide,
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    capabilities: [
      ...(options.savedView === undefined ? [] : [ROSTER_BRIDGE_SAVED_CAPABILITY]),
      ...(options.offerCapabilities !== undefined
        ? [...options.offerCapabilities]
        : options.offer === false
          ? []
          : [ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY]),
    ],
    onReviewSettingsPolicy: (policy) => policies.push(policy),
  });
  return {
    channels,
    inventory,
    host,
    binding,
    viewer,
    policies,
    ownerDiagnostics,
    async stop(): Promise<void> {
      await Promise.allSettled([viewer.stop(), host.stopAll()]);
      await channels.viewerSide.close().catch(() => undefined);
    },
  };
}

function ownerHarness(options: HarnessOptions = {}) {
  const channels = pair();
  const inventory = new FakeInventory();
  inventory.rows = (options.rows ?? []).map(ownerRow);
  const ownerDiagnostics: string[] = [];
  const host = createRosterBridgeHost({
    inventory,
    authorizePeer: options.authorize ?? (() => true),
    bounds: { ...FAST_BOUNDS, ...options.bounds },
    onDiagnostic: (event) => ownerDiagnostics.push(event.code),
    ...(options.provider === undefined && options.policy === undefined
      ? {}
      : {
        reviewSettingsProvider: options.provider as OwnerReviewSettingsHandler,
        remoteReviewSettingsExposed: options.policy as OwnerReviewSettingsPolicy,
      }),
  });
  const binding = host.attach(channels.ownerSide);
  const scripted = new ScriptedViewer(channels.viewerSide);
  return {
    channels,
    inventory,
    host,
    binding,
    scripted,
    ownerDiagnostics,
    async stop(): Promise<void> {
      await host.stopAll();
      await channels.viewerSide.close().catch(() => undefined);
    },
  };
}

async function subscribeReal(viewer: ReturnType<typeof harness>["viewer"]): Promise<void> {
  await viewer.hello;
  await viewer.subscribe();
  await until(() => viewer.reviewSettings?.policy !== undefined);
}

async function subscribeScripted(
  scripted: ScriptedViewer,
  channels: Pair,
): Promise<void> {
  scripted.hello();
  await until(() => channels.ownerSide.frames().some((frame) => frame.type === "hello_ack"));
  scripted.subscribe();
  await until(() => channels.ownerSide.frames().some((frame) => frame.type === "snapshot_end"));
  await until(() => channels.ownerSide.frames().some((frame) => frame.type === "review_settings_policy"));
}

function reviewFrames(side: Channel): RosterBridgeFrame[] {
  return side.frames().filter((frame) => [
    "review_settings_begin",
    "review_settings_chunk",
    "review_settings_end",
    "review_settings_result",
    "review_settings_payload_begin",
    "review_settings_payload_chunk",
    "review_settings_payload_end",
    "review_settings_policy",
  ].includes(frame.type));
}

test("Review settings negotiate only with both owner callbacks and never widen a legacy lane", async () => {
  const legacy = harness({ offer: true });
  try {
    await legacy.viewer.hello;
    assert.equal(legacy.viewer.reviewSettings?.supported, false);
    assert.deepEqual(await legacy.viewer.reviewSettings?.load({ hostRunId: RUN }), {
      kind: "not-sent",
      reason: "capability-unsupported",
    });
    await legacy.viewer.subscribe();
    assert.deepEqual(reviewFrames(legacy.channels.ownerSide).map((frame) => frame.type),
      [], "a provider-less owner never acknowledges or writes the lane");
    assert.equal(legacy.viewer.reviewSettings?.policy, undefined);
  } finally {
    await legacy.stop();
  }

  const provider: OwnerReviewSettingsHandler = async () => ({ kind: "accepted" });
  const unoffered = harness({ provider, policy: () => true, offer: false });
  try {
    await unoffered.viewer.hello;
    assert.deepEqual(unoffered.viewer.capabilities, [ROSTER_BRIDGE_REQUIRED_CAPABILITY]);
    assert.equal(unoffered.viewer.reviewSettings?.supported, false);
  } finally {
    await unoffered.stop();
  }

  const inventory = new FakeInventory();
  assert.throws(
    () => createRosterBridgeHost({ inventory, authorizePeer: () => true, reviewSettingsProvider: provider }),
    /together/,
    "a provider without a live opt-in is a partial configuration",
  );
  assert.throws(
    () => createRosterBridgeHost({ inventory, authorizePeer: () => true, remoteReviewSettingsExposed: () => true }),
    /together/,
    "an opt-in without a provider is a partial configuration",
  );
  const legacyHost = createRosterBridgeHost({ inventory, authorizePeer: () => true });
  assert.doesNotThrow(() => legacyHost.notifyReviewSettingsPolicy?.());

  const both = harness({ provider, policy: () => true });
  try {
    await both.viewer.hello;
    assert.deepEqual(both.viewer.capabilities, [
      ROSTER_BRIDGE_REQUIRED_CAPABILITY,
      ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY,
    ]);
    assert.equal(both.viewer.reviewSettings?.supported, true);
    await both.viewer.subscribe();
    await until(() => both.viewer.reviewSettings?.policy?.enabled === true);
    assert.deepEqual(both.viewer.reviewSettings?.policy, { hostRunId: RUN, enabled: true });
    assert.ok(reviewFrames(both.channels.ownerSide).some((frame) => frame.type === "review_settings_policy"));
  } finally {
    await both.stop();
  }
});

test("a pre-change Review-settings generation never negotiates the lane for the new payload", async () => {
  // The lane identifier carries the payload generation. Generation 1's closed
  // opening and save intent have no per-provider automatic primary review
  // fields, so a peer that advertises only that identifier is unknown here:
  // the lane is never acknowledged, no policy frame is written, and no v1
  // payload can reach a decoder that would read it as missing fields (#736).
  assert.notEqual(ROSTER_BRIDGE_REVIEW_SETTINGS_CAPABILITY, "roster-review-settings-v1");
  const provider: OwnerReviewSettingsHandler = async () => ({ kind: "accepted" });
  const mixed = harness({ provider, policy: () => true, offerCapabilities: ["roster-review-settings-v1"] });
  try {
    await mixed.viewer.hello;
    assert.deepEqual(
      mixed.viewer.capabilities,
      [ROSTER_BRIDGE_REQUIRED_CAPABILITY],
      "the pre-change identifier is never acknowledged",
    );
    assert.equal(mixed.viewer.reviewSettings?.supported, false);
    assert.deepEqual(await mixed.viewer.reviewSettings?.load({ hostRunId: RUN }), {
      kind: "not-sent",
      reason: "capability-unsupported",
    });
    await mixed.viewer.subscribe();
    await tick();
    assert.deepEqual(
      reviewFrames(mixed.channels.ownerSide).map((frame) => frame.type),
      [],
      "the owner writes no Review-settings frame for an unacknowledged generation",
    );
  } finally {
    await mixed.stop();
  }
});

test("load carries the exact large payload and exact owner request in both directions", async () => {
  const payload = json({
    catalog: "x".repeat(100 * 1024),
    unicode: "宇宙 😀",
    nested: { model: "gpt", reasoning: "high" },
  });
  const calls: OwnerReviewSettingsRequest[] = [];
  const provider: OwnerReviewSettingsHandler = async (request) => {
    calls.push(Object.freeze({
      kind: request.kind,
      hostRunId: request.hostRunId,
      peerKey: { ...request.peerKey },
      ...(request.payload === undefined ? {} : { payload: Uint8Array.from(request.payload) }),
    }));
    return { kind: "accepted", payload: Uint8Array.from(payload) };
  };
  const h = harness({ provider, policy: () => true });
  try {
    await subscribeReal(h.viewer);
    const result = await h.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.equal(result.kind, "owner-result");
    assert.ok(result.kind === "owner-result" && result.outcome.kind === "loaded");
    assert.deepEqual(result.outcome.payload, payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, "load");
    assert.equal(calls[0]?.hostRunId, RUN);
    assert.deepEqual(calls[0]?.peerKey, h.channels.ownerSide.peerKey,
      "the provider sees the authenticated peer from the bound channel, never a frame field");
    assert.equal(calls[0]?.payload, undefined, "a load carries no request payload");
    const frames = reviewFrames(h.channels.ownerSide)
      .filter((frame) => frame.type === "review_settings_payload_begin"
        || frame.type === "review_settings_payload_chunk"
        || frame.type === "review_settings_payload_end");
    assert.equal(frames[0]?.type, "review_settings_payload_begin");
    assert.equal(frames[frames.length - 1]?.type, "review_settings_payload_end");
    assert.ok(frames.filter((frame) => frame.type === "review_settings_payload_chunk").length > 1);
    for (const frame of h.channels.ownerSide.frames()) {
      assert.ok(encodeRosterBridgeFrame(frame).length <= 65_536);
    }
  } finally {
    await h.stop();
  }
});

test("save carries the exact bytes and correlates one accepted owner result", async () => {
  const payload = json({ tasks: ["x".repeat(90 * 1024)], browser: { allowed: true } });
  const calls: OwnerReviewSettingsRequest[] = [];
  const provider: OwnerReviewSettingsHandler = async (request) => {
    calls.push(request);
    return { kind: "accepted" };
  };
  const h = harness({ provider, policy: () => true });
  try {
    await subscribeReal(h.viewer);
    const result = await h.viewer.reviewSettings!.save({ hostRunId: RUN, payload });
    assert.deepEqual(result, { kind: "owner-result", outcome: { kind: "accepted" } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.kind, "save");
    assert.equal(calls[0]?.hostRunId, RUN);
    assert.deepEqual(calls[0]?.payload, payload);
    assert.deepEqual(calls[0]?.peerKey, h.channels.ownerSide.peerKey);
    const requestFrames = h.channels.viewerSide.frames();
    assert.equal(requestFrames.filter((frame) => frame.type === "review_settings_begin").length, 1);
    assert.ok(requestFrames.filter((frame) => frame.type === "review_settings_chunk").length > 1);
    assert.equal(requestFrames.filter((frame) => frame.type === "review_settings_end").length, 1);
    for (const frame of requestFrames) assert.ok(encodeRosterBridgeFrame(frame).length <= 65_536);
    assert.ok(!reviewFrames(h.channels.ownerSide).some((frame) => frame.type === "review_settings_payload_begin"),
      "a save acceptance is a fixed result, never a payload transfer");
  } finally {
    await h.stop();
  }
});

test("a confirmed save carries only its bounded auto-disable receipt across the lane", async () => {
  const receipt = { disabledTaskIds: ["task-1a2b3c4d", "task-2"], additionalDisabledCount: 1 };
  const provider: OwnerReviewSettingsHandler = async (request) => request.kind === "save"
    ? { kind: "accepted", receipt }
    : { kind: "accepted", payload: json({ ok: true }) };
  const h = harness({ provider, policy: () => true });
  try {
    await subscribeReal(h.viewer);
    const result = await h.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({}) });
    // The requester observes the same bounded identities and exact remainder,
    // and nothing else, across the real paired lane.
    assert.deepEqual(result, { kind: "owner-result", outcome: { kind: "accepted", receipt } });
    const resultFrame = reviewFrames(h.channels.ownerSide)
      .find((frame) => frame.type === "review_settings_result");
    assert.deepEqual(resultFrame, {
      type: "review_settings_result",
      requestId: "1",
      outcome: { kind: "accepted", receipt },
    });
  } finally {
    await h.stop();
  }

  // A receipt answers a save only: it never becomes a load's payload transfer.
  const receiptOnly = harness({
    policy: () => true,
    provider: async () => ({ kind: "accepted", receipt }),
  });
  try {
    await subscribeReal(receiptOnly.viewer);
    assert.deepEqual(await receiptOnly.viewer.reviewSettings!.load({ hostRunId: RUN }), {
      kind: "owner-result",
      outcome: { kind: "unknown" },
    });
    assert.equal(reviewFrames(receiptOnly.channels.ownerSide)
      .some((frame) => frame.type === "review_settings_payload_begin"), false);
  } finally {
    await receiptOnly.stop();
  }

  // A receipt outside the closed bounds is not a fact this lane may forward,
  // so the requester learns nothing rather than a fabricated clean save.
  const malformed = harness({
    policy: () => true,
    provider: async () => ({
      kind: "accepted",
      receipt: { disabledTaskIds: ["not a task id"], additionalDisabledCount: 0 },
    } as unknown as OwnerReviewSettingsFacts),
  });
  try {
    await subscribeReal(malformed.viewer);
    assert.deepEqual(await malformed.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({}) }), {
      kind: "owner-result",
      outcome: { kind: "unknown" },
    });
    const forwarded = reviewFrames(malformed.channels.ownerSide)
      .find((frame) => frame.type === "review_settings_result");
    assert.deepEqual(forwarded, {
      type: "review_settings_result",
      requestId: "1",
      outcome: { kind: "unknown" },
    });
  } finally {
    await malformed.stop();
  }
});

test("a receipt that cannot fit the result budget keeps the exact disable total", async () => {
  // Four long identities plus the result envelope exceed the 514-byte bound this
  // harness also exercises elsewhere, so the identity list must shrink while the
  // total (4 listed + 2 remainder = 6) stays exact.
  const longIds = Array.from({ length: 4 }, (_unused, index) => `task-${index}-${"x".repeat(120)}`);
  const h = harness({
    policy: () => true,
    provider: async () => ({
      kind: "accepted",
      receipt: { disabledTaskIds: longIds, additionalDisabledCount: 2 },
    }),
    bounds: { maxFrameBytes: 514, maxPageBytes: 514, maxSnapshotBytes: 514 },
  });
  try {
    await subscribeReal(h.viewer);
    const result = await h.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({}) });
    assert.equal(result.kind, "owner-result", "a fitted receipt still confirms the save");
    assert.ok(result.kind === "owner-result" && result.outcome.kind === "accepted");
    const receipt = result.outcome.receipt;
    assert.ok(receipt, "the fitted acceptance still reports the auto-disable total");
    assert.equal(receipt.disabledTaskIds.length + receipt.additionalDisabledCount, 6);
    assert.ok(receipt.disabledTaskIds.length < longIds.length,
      "identities that do not fit move into the exact remainder");
  } finally {
    await h.stop();
  }
});

test("a save above the effective frame-sized limit is refused before submission", async () => {
  let calls = 0;
  const h = harness({
    policy: () => true,
    provider: async () => {
      calls += 1;
      return { kind: "accepted" };
    },
    bounds: { maxFrameBytes: 514, maxPageBytes: 514, maxSnapshotBytes: 514 },
  });
  try {
    await subscribeReal(h.viewer);
    const before = h.channels.viewerSide.frames()
      .filter((frame) => frame.type === "review_settings_begin").length;
    const result = await h.viewer.reviewSettings!.save({
      hostRunId: RUN,
      payload: new Uint8Array(REVIEW_SETTINGS_MAX_BYTES),
    });
    assert.deepEqual(result, { kind: "not-sent", reason: "limit" });
    assert.equal(h.channels.viewerSide.frames()
      .filter((frame) => frame.type === "review_settings_begin").length, before);
    assert.equal(calls, 0);
  } finally {
    await h.stop();
  }
});

test("an owner load payload above the effective frame-sized limit is refused without fragmentation", async () => {
  const h = harness({
    policy: () => true,
    provider: async () => ({ kind: "accepted", payload: json({ x: "a".repeat(6_000) }) }),
    bounds: { maxFrameBytes: 514, maxPageBytes: 514, maxSnapshotBytes: 514 },
  });
  try {
    await subscribeReal(h.viewer);
    const result = await h.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.deepEqual(result, {
      kind: "owner-result",
      outcome: { kind: "refused", reason: "limit" },
    });
    assert.equal(reviewFrames(h.channels.ownerSide)
      .some((frame) => frame.type === "review_settings_payload_begin"), false);
  } finally {
    await h.stop();
  }
});

test("live opt-in is checked independently for load and save, even after an enabled description", async () => {
  let enabled = true;
  let calls = 0;
  const provider: OwnerReviewSettingsHandler = async (request) => {
    calls += 1;
    return request.kind === "load"
      ? { kind: "accepted", payload: json({ enabled: true }) }
      : { kind: "accepted" };
  };
  const h = harness({ provider, policy: () => enabled });
  try {
    await subscribeReal(h.viewer);
    assert.deepEqual(h.viewer.reviewSettings?.policy, { hostRunId: RUN, enabled: true });
    enabled = false;
    // Do not publish the change: the advertised description stays stale, and
    // each operation must still consult the owner's live callback.
    assert.deepEqual(await h.viewer.reviewSettings!.load({ hostRunId: RUN }), {
      kind: "owner-result",
      outcome: { kind: "refused", reason: "policy" },
    });
    assert.deepEqual(await h.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({ a: 1 }) }), {
      kind: "owner-result",
      outcome: { kind: "refused", reason: "policy" },
    });
    assert.equal(calls, 0);
    h.host.notifyReviewSettingsPolicy?.();
    await until(() => h.viewer.reviewSettings?.policy?.enabled === false);
    enabled = true;
    h.host.notifyReviewSettingsPolicy?.();
    await until(() => h.viewer.reviewSettings?.policy?.enabled === true);
    const loaded = await h.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.ok(loaded.kind === "owner-result" && loaded.outcome.kind === "loaded");
    assert.equal(calls, 1);
  } finally {
    await h.stop();
  }
});

test("a refused save discards in-flight fragments and leaves the roster lane alive", async () => {
  let calls = 0;
  const h = harness({
    policy: () => false,
    provider: async () => {
      calls += 1;
      return { kind: "accepted" };
    },
  });
  const held = { refusal: null as Buffer | null };
  h.channels.ownerSide.intercept = (frame) => {
    if (frame.type !== "review_settings_result") return undefined;
    held.refusal = encodeRosterBridgeFrame(frame);
    return "drop";
  };
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    await until(() => h.viewer.reviewSettings?.policy !== undefined);
    const pending = h.viewer.reviewSettings!.save({
      hostRunId: RUN,
      payload: json({ pad: "z".repeat(20 * 1024) }),
    });
    // Let the viewer's ordered fragments reach the owner while the refusal is
    // deliberately held back, reproducing the ordinary race the reviewer named.
    await until(() => h.channels.ownerSide.received
      .some((frame) => frame.type === "review_settings_chunk"));
    await until(() => held.refusal !== null);
    const refusal = held.refusal;
    if (refusal === null) throw new Error("the held refusal was not captured");
    h.channels.viewerSide.deliver(refusal);
    assert.deepEqual(await pending, {
      kind: "owner-result",
      outcome: { kind: "refused", reason: "policy" },
    });
    assert.equal(calls, 0);
    // The shared roster channel must still deliver a subsequent update.
    h.inventory.rows = [ownerRow("after-refusal")];
    const next = h.inventory.emit();
    await until(() => h.viewer.projection.revision === next.revision);
    assert.equal(h.viewer.projection.rows[0]?.label, "Row after-refusal");
    assert.ok(h.viewer.projection.revision !== first.revision);
  } finally {
    await h.stop();
  }
});

test("a begin denied by the live grant cannot be replayed after restoration", async () => {
  let granted = true;
  let calls = 0;
  const h = ownerHarness({
    authorize: () => granted,
    policy: () => true,
    provider: () => {
      calls += 1;
      return { kind: "accepted", payload: json({ ok: true }) };
    },
  });
  try {
    await subscribeScripted(h.scripted, h.channels);
    const begin = (sequence: number): RosterBridgeFrame => ({
      type: "review_settings_begin",
      requestId: String(sequence),
      hostRunId: RUN,
      operation: "load",
      sequence,
      bytes: 0,
      sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    });
    granted = false;
    h.scripted.write(begin(1));
    assert.ok(h.ownerDiagnostics.includes("review_settings_refused"));
    granted = true;
    h.scripted.write(begin(1));
    await tick();
    assert.equal(calls, 0);
    h.scripted.write(begin(2));
    await until(() => calls === 1);
  } finally {
    await h.stop();
  }
});

test("owner re-proves the live opt-in before invocation and before reply", async () => {
  let armed = false;
  let policyReads = 0;
  let calls = 0;
  const h = harness({
    policy: () => {
      if (!armed) return true;
      policyReads += 1;
      // The direct admission check is the first read and the full pre-invocation
      // re-proof is the second. Turning off for that second read must keep the
      // provider unreachable.
      return policyReads < 2;
    },
    provider: async () => {
      calls += 1;
      return { kind: "accepted", payload: json({ should: "not arrive" }) };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    await until(() => h.viewer.reviewSettings?.policy !== undefined);
    armed = true;
    const result = await h.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(calls, 0, "the provider is never invoked after the live proof fails");
  } finally {
    await h.stop();
  }

  let flipAfterProvider = true;
  const replyH = harness({
    policy: () => flipAfterProvider,
    provider: async () => {
      flipAfterProvider = false;
      return { kind: "accepted", payload: json({ not: "delivered" }) };
    },
  });
  try {
    await replyH.viewer.hello;
    await replyH.viewer.subscribe();
    const result = await replyH.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.deepEqual(result, { kind: "unknown" }, "a reply with the live opt-in off is dropped");
    assert.equal(reviewFrames(replyH.channels.ownerSide)
      .some((frame) => frame.type === "review_settings_payload_begin"), false);
    assert.ok(replyH.ownerDiagnostics.includes("review_settings_refused"));
  } finally {
    await replyH.stop();
  }
});

test("malformed, duplicated, stale, and incomplete request transfers reach no provider", async () => {
  const failures = ["missing-end", "hash", "index", "bytes", "invalid-json", "duplicate-begin", "no-end-timeout"] as const;
  for (const failure of failures) {
    let calls = 0;
    const provider: OwnerReviewSettingsHandler = async (request) => {
      calls += 1;
      return request.kind === "load" ? { kind: "accepted", payload: json({ ok: true }) } : { kind: "accepted" };
    };
    const h = ownerHarness({ provider, policy: () => true });
    try {
      await subscribeScripted(h.scripted, h.channels);
      const bytes = json({ a: 1 });
      const begin: RosterBridgeFrame = {
        type: "review_settings_begin",
        requestId: "1",
        hostRunId: RUN,
        operation: "save",
        sequence: 1,
        bytes: bytes.length,
        sha256: hash(bytes),
      };
      const chunk: RosterBridgeReviewSettingsChunkFrame = {
        type: "review_settings_chunk",
        requestId: "1",
        index: 0,
        data: Buffer.from(bytes).toString("base64"),
      };
      const end: RosterBridgeReviewSettingsEndFrame = {
        type: "review_settings_end",
        requestId: "1",
        chunks: 1,
      };
      const bad = new TextEncoder().encode("not json");
      h.scripted.write(failure === "hash"
        ? { ...begin, sha256: "0".repeat(64) }
        : failure === "bytes"
          ? { ...begin, bytes: 1 }
          : failure === "invalid-json"
            ? { ...begin, bytes: bad.length, sha256: hash(bad) }
            : begin);
      if (failure === "duplicate-begin") {
        h.scripted.write(begin);
      } else if (failure === "index") {
        h.scripted.write({ ...chunk, index: 1 });
      } else if (failure === "bytes") {
        h.scripted.write(chunk);
      } else if (failure === "invalid-json") {
        h.scripted.write({ ...chunk, data: Buffer.from(bad).toString("base64") });
        h.scripted.write(end);
      } else if (failure === "no-end-timeout") {
        h.scripted.write(chunk);
      } else {
        h.scripted.write(chunk);
        if (failure !== "missing-end") h.scripted.write(end);
      }
      await new Promise((resolve) => setTimeout(resolve, failure === "no-end-timeout" ? 350 : 80));
      assert.equal(calls, 0, `${failure} must not invoke the provider`);
      if (failure === "no-end-timeout") {
        h.scripted.write(end);
        await tick();
        assert.equal(calls, 0, "a late end after assembly expiry is never dispatched");
      }
    } finally {
      await h.stop();
    }
  }

  let calls = 0;
  const provider: OwnerReviewSettingsHandler = async () => {
    calls += 1;
    return { kind: "accepted" };
  };
  const h = ownerHarness({ provider, policy: () => true });
  try {
    await subscribeScripted(h.scripted, h.channels);
    // A load has no request payload; a chunk for it is outside the protocol.
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "load",
      sequence: 1,
      bytes: 0,
      sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    });
    await until(() => calls === 1);
    h.scripted.write({ type: "review_settings_chunk", requestId: "1", index: 0, data: "YQ==" });
    await tick();
    assert.equal(calls, 1, "a chunk after a load cannot reach a save provider");
    assert.ok(h.channels.ownerSide.frames().some((frame) => frame.type === "error" && frame.code === "bad_frame"));
  } finally {
    await h.stop();
  }
});

test("duplicate and older sequences are silently dropped before provider work", async () => {
  let calls = 0;
  const provider: OwnerReviewSettingsHandler = async () => {
    calls += 1;
    return { kind: "accepted", payload: json({ ok: true }) };
  };
  const h = ownerHarness({ provider, policy: () => true });
  try {
    await subscribeScripted(h.scripted, h.channels);
    const begin = (requestId: string, sequence: number): RosterBridgeFrame => ({
      type: "review_settings_begin",
      requestId,
      hostRunId: RUN,
      operation: "load",
      sequence,
      bytes: 0,
      sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    });
    h.scripted.write(begin("1", 1));
    await until(() => calls === 1);
    await until(() => h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_payload_end" && frame.requestId === "1"));
    h.scripted.write(begin("1", 1));
    h.scripted.write(begin("1", 1));
    await tick();
    assert.equal(calls, 1, "no stale or replayed sequence invokes the provider");
    assert.equal(h.channels.ownerSide.frames().filter((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1").length, 0,
    "a non-active duplicate is dropped without a second answer");
    h.scripted.write(begin("2", 2));
    await until(() => calls === 2);
  } finally {
    await h.stop();
  }
});

test("a reused ID with a higher sequence is a protocol violation and never reopens the request", async () => {
  let calls = 0;
  const h = ownerHarness({
    policy: () => false,
    provider: async () => {
      calls += 1;
      return { kind: "accepted" };
    },
  });
  try {
    await subscribeScripted(h.scripted, h.channels);
    const bytes = json({ a: 1 });
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "save",
      sequence: 1,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    await until(() => h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"));
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "save",
      sequence: 2,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    await tick();
    assert.equal(calls, 0);
    assert.ok(h.channels.ownerSide.frames().some((frame) =>
      frame.type === "error" && frame.code === "bad_frame"));
  } finally {
    await h.stop();
  }
});

test("a replay after provider completion is silently dropped", async () => {
  let calls = 0;
  const h = ownerHarness({
    policy: () => true,
    provider: async () => {
      calls += 1;
      return { kind: "accepted" };
    },
  });
  try {
    await subscribeScripted(h.scripted, h.channels);
    const bytes = json({ a: 1 });
    const begin: RosterBridgeFrame = {
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "save",
      sequence: 1,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
    h.scripted.write(begin);
    h.scripted.write({
      type: "review_settings_chunk",
      requestId: "1",
      index: 0,
      data: Buffer.from(bytes).toString("base64"),
    });
    h.scripted.write({ type: "review_settings_end", requestId: "1", chunks: 1 });
    await until(() => h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"));
    h.scripted.write(begin);
    await tick();
    assert.equal(calls, 1);
    assert.equal(h.channels.ownerSide.frames().filter((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1").length, 1,
    "a completed request is never answered twice");
  } finally {
    await h.stop();
  }
});

test("a conflicting save begin aborts its assembly and late fragments stay harmless", async () => {
  let calls = 0;
  const h = ownerHarness({
    policy: () => true,
    provider: async (request) => {
      calls += 1;
      return request.kind === "load"
        ? { kind: "accepted", payload: json({ ok: true }) }
        : { kind: "accepted" };
    },
  });
  try {
    await subscribeScripted(h.scripted, h.channels);
    const bytes = json({ a: 1 });
    const begin: RosterBridgeFrame = {
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "save",
      sequence: 1,
      bytes: bytes.length,
      sha256: hash(bytes),
    };
    h.scripted.write(begin);
    await tick();
    h.scripted.write(begin);
    await until(() => h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"));
    assert.equal(calls, 0, "the aborted assembly never reaches the provider");
    h.scripted.write({
      type: "review_settings_chunk",
      requestId: "1",
      index: 0,
      data: Buffer.from(bytes).toString("base64"),
    });
    h.scripted.write({ type: "review_settings_end", requestId: "1", chunks: 1 });
    await tick();
    assert.equal(calls, 0, "late fragments are discarded, not dispatched");
    // The same channel still accepts a fresh request after the refusal.
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "2",
      hostRunId: RUN,
      operation: "load",
      sequence: 2,
      bytes: 0,
      sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    });
    await until(() => calls === 1);
    assert.ok(h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_payload_begin" && frame.requestId === "2"));
  } finally {
    await h.stop();
  }
});

test("a duplicate begin after provider invocation never emits a contradictory refusal", async () => {
  let calls = 0;
  let releaseProvider: (facts: OwnerReviewSettingsFacts) => void = () => undefined;
  const h = ownerHarness({
    policy: () => true,
    provider: async () => {
      calls += 1;
      return new Promise<OwnerReviewSettingsFacts>((resolve) => {
        releaseProvider = resolve;
      });
    },
  });
  try {
    await subscribeScripted(h.scripted, h.channels);
    const bytes = json({ a: 1 });
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "save",
      sequence: 1,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    h.scripted.write({
      type: "review_settings_chunk",
      requestId: "1",
      index: 0,
      data: Buffer.from(bytes).toString("base64"),
    });
    h.scripted.write({ type: "review_settings_end", requestId: "1", chunks: 1 });
    await until(() => calls === 1);
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "save",
      sequence: 1,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
    await tick();
    assert.equal(h.channels.ownerSide.frames().filter((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1").length, 0,
    "no refusal may contradict work already in progress");
    releaseProvider({ kind: "accepted" });
    await until(() => h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"));
    assert.deepEqual(h.channels.ownerSide.frames().filter((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"), [{
      type: "review_settings_result",
      requestId: "1",
      outcome: { kind: "accepted" },
    }]);
  } finally {
    await h.stop();
  }
});

test("a same-run resync cannot revive an old guard and keeps the provider slot busy", async () => {
  let calls = 0;
  const held: {
    guard: (() => boolean) | null;
    release: ((facts: OwnerReviewSettingsFacts) => void) | null;
  } = { guard: null, release: null };
  const h = harness({
    policy: () => true,
    provider: async (_request, stillAuthorized) => {
      calls += 1;
      if (calls === 1) {
        held.guard = stillAuthorized;
        return new Promise<OwnerReviewSettingsFacts>((resolve) => {
          held.release = resolve;
        });
      }
      return { kind: "accepted", payload: json({ ok: true }) };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    await until(() => h.viewer.reviewSettings?.policy !== undefined);
    const oldSave = h.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({ a: 1 }) });
    await until(() => calls === 1);
    assert.ok(held.guard);
    const oldRequestId = (h.channels.viewerSide.frames()
      .find((frame) => frame.type === "review_settings_begin") as { requestId: string }).requestId;
    const resynced = await h.viewer.resync();
    assert.equal(resynced.state, "current");
    assert.deepEqual(await oldSave, { kind: "unknown" });
    assert.equal((held.guard as () => boolean)(), false,
      "the old guard is pinned to the retired subscription generation");
    h.inventory.rows = [ownerRow("after-resync")];
    const next = h.inventory.emit();
    await until(() => h.viewer.projection.revision === next.revision);
    assert.equal(h.viewer.projection.state, "current");
    // The old provider still occupies this binding's one provider slot.
    assert.deepEqual(await h.viewer.reviewSettings!.load({ hostRunId: RUN }), {
      kind: "owner-result",
      outcome: { kind: "refused", reason: "busy" },
    });
    assert.ok(held.release);
    (held.release as (facts: OwnerReviewSettingsFacts) => void)({ kind: "accepted" });
    await tick();
    assert.equal(h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_result" && frame.requestId === oldRequestId), false,
    "the old provider's result is not delivered after retirement");
    const loaded = await h.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.ok(loaded.kind === "owner-result" && loaded.outcome.kind === "loaded");
    assert.equal(calls, 2);
  } finally {
    await h.stop();
  }
});

test("a begin still queued at timeout is not-sent and ignores early replies", async () => {
  let providerCalls = 0;
  const h = harness({
    policy: () => true,
    close: async () => ({ kind: "unknown" }),
    provider: async () => {
      providerCalls += 1;
      return { kind: "accepted" };
    },
  });
  try {
    await subscribeReal(h.viewer);
    h.channels.viewerSide.hold = true;
    const closePending = h.viewer.closeSession({ hostRunId: RUN, rowId: "row", confirmed: true });
    const settingsPending = h.viewer.reviewSettings!.load({ hostRunId: RUN });
    // The begin is still queued behind the held close write. A reply now cannot
    // be an answer to it and must not settle the request.
    h.channels.viewerSide.deliver(encodeRosterBridgeFrame({
      type: "review_settings_result",
      requestId: "1",
      outcome: { kind: "refused", reason: "policy" },
    }));
    assert.deepEqual(await settingsPending, { kind: "not-sent", reason: "not-ready" });
    assert.equal(h.channels.viewerSide.frames()
      .some((frame) => frame.type === "review_settings_begin"), false);
    h.channels.viewerSide.release();
    await closePending.catch(() => undefined);
    await tick();
    assert.equal(h.channels.viewerSide.frames()
      .some((frame) => frame.type === "review_settings_begin"), false);
    assert.equal(providerCalls, 0);
  } finally {
    await h.stop();
  }
});

test("a save acceptance before the end handoff is rejected", async () => {
  let providerCalls = 0;
  const h = harness({
    policy: () => true,
    provider: async () => {
      providerCalls += 1;
      return { kind: "accepted" };
    },
  });
  try {
    await subscribeReal(h.viewer);
    h.channels.viewerSide.hold = true;
    const pending = h.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({ a: 1 }) });
    await until(() => h.channels.viewerSide.frames()
      .some((frame) => frame.type === "review_settings_begin"));
    h.channels.viewerSide.deliver(encodeRosterBridgeFrame({
      type: "review_settings_result",
      requestId: "1",
      outcome: { kind: "accepted" },
    }));
    assert.deepEqual(await pending, { kind: "unknown" });
    assert.equal(providerCalls, 0, "an acceptance before the save end is impossible");
  } finally {
    await h.stop();
  }
});

test("a request naming another owner run is refused stale before provider work", async () => {
  let calls = 0;
  const h = ownerHarness({
    policy: () => true,
    provider: async () => {
      calls += 1;
      return { kind: "accepted", payload: json({ ok: true }) };
    },
  });
  try {
    await subscribeScripted(h.scripted, h.channels);
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: "another-run",
      operation: "load",
      sequence: 1,
      bytes: 0,
      sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    });
    await until(() => h.channels.ownerSide.frames().some((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"));
    assert.equal(calls, 0);
    assert.deepEqual(h.channels.ownerSide.frames().find((frame) =>
      frame.type === "review_settings_result" && frame.requestId === "1"), {
      type: "review_settings_result",
      requestId: "1",
      outcome: { kind: "refused", reason: "stale" },
    });
  } finally {
    await h.stop();
  }
});

test("a mismatched load payload run is unknown and never delivered", async () => {
  const payload = json({ secret: "owner-only" });
  const h = harness({
    policy: () => true,
    provider: async () => ({ kind: "accepted", payload }),
  });
  let dropped = false;
  h.channels.ownerSide.intercept = (frame) => {
    if (!frame.type.startsWith("review_settings_payload_")) return undefined;
    if (frame.type === "review_settings_payload_begin") dropped = true;
    return "drop";
  };
  try {
    await subscribeReal(h.viewer);
    const pending = h.viewer.reviewSettings!.load({ hostRunId: RUN });
    await until(() => dropped);
    h.channels.viewerSide.deliver(encodeRosterBridgeFrame({
      type: "review_settings_payload_begin",
      requestId: h.channels.viewerSide.frames()
        .filter((frame) => frame.type === "review_settings_begin")
        .map((frame) => (frame as { requestId: string }).requestId)[0] as string,
      hostRunId: "another-run",
      bytes: payload.length,
      sha256: hash(payload),
    }));
    assert.deepEqual(await pending, { kind: "unknown" });
  } finally {
    await h.stop();
  }
});

test("channel closure while a request is outstanding is unknown, never replayed", async () => {
  const h = harness({
    policy: () => true,
    provider: async () => ({ kind: "accepted", payload: json({ late: "payload" }) }),
  });
  h.channels.ownerSide.intercept = (frame) => frame.type === "review_settings_payload_chunk" ? "drop" : undefined;
  try {
    await subscribeReal(h.viewer);
    const pending = h.viewer.reviewSettings!.load({ hostRunId: RUN });
    await until(() => h.channels.ownerSide.frames().some((frame) => frame.type === "review_settings_payload_begin"));
    await h.channels.ownerSide.close();
    assert.deepEqual(await pending, { kind: "unknown" });
    assert.equal(h.channels.viewerSide.frames()
      .filter((frame) => frame.type === "review_settings_begin").length, 1,
    "closure does not resend or reconnect the request");
  } finally {
    await h.stop();
  }
});

test("incomplete owner load payload and a lost save result are unknown, never replayed", async () => {
  const payload = json({ large: "y".repeat(80 * 1024) });
  const loadH = harness({
    policy: () => true,
    provider: async () => ({ kind: "accepted", payload }),
  });
  loadH.channels.ownerSide.intercept = (frame) => frame.type === "review_settings_payload_end" ? "drop" : undefined;
  try {
    await subscribeReal(loadH.viewer);
    const result = await loadH.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(reviewFrames(loadH.channels.ownerSide)
      .filter((frame) => frame.type === "review_settings_payload_begin").length, 1,
    "no replay of the load request or its payload");
  } finally {
    await loadH.stop();
  }

  let saveCalls = 0;
  const saveH = harness({
    policy: () => true,
    provider: async () => {
      saveCalls += 1;
      return { kind: "accepted" };
    },
  });
  saveH.channels.ownerSide.intercept = (frame) => frame.type === "review_settings_result" ? "drop" : undefined;
  try {
    await subscribeReal(saveH.viewer);
    const result = await saveH.viewer.reviewSettings!.save({ hostRunId: RUN, payload: json({ a: 1 }) });
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(saveCalls, 1);
    assert.equal(saveH.channels.viewerSide.frames()
      .filter((frame) => frame.type === "review_settings_begin").length, 1,
    "no replay after a lost result");
  } finally {
    await saveH.stop();
  }
});

test("the caller's stillCurrent fence refuses before begin and never claims not-sent after fragments", async () => {
  let calls = 0;
  const provider: OwnerReviewSettingsHandler = async () => {
    calls += 1;
    return { kind: "accepted" };
  };
  const h = harness({ provider, policy: () => true });
  try {
    await subscribeReal(h.viewer);
    const before = h.channels.viewerSide.frames().filter((frame) => frame.type === "review_settings_begin").length;
    assert.deepEqual(
      await h.viewer.reviewSettings!.load({ hostRunId: RUN }, { stillCurrent: () => false }),
      { kind: "not-sent", reason: "target-unavailable" },
    );
    assert.equal(h.channels.viewerSide.frames().filter((frame) => frame.type === "review_settings_begin").length, before);
    let current = true;
    h.channels.viewerSide.intercept = (frame) => {
      if (frame.type === "review_settings_begin") current = false;
    };
    const result = await h.viewer.reviewSettings!.save(
      { hostRunId: RUN, payload: json({ pad: "z".repeat(20 * 1024) }) },
      { stillCurrent: () => current },
    );
    assert.deepEqual(result, { kind: "unknown" });
    assert.equal(calls, 0);
    assert.equal(h.channels.viewerSide.frames().some((frame) => frame.type === "review_settings_end"), false);
  } finally {
    await h.stop();
  }
});

test("a large load interleaves with roster publications without stalling either lane", async () => {
  const payload = json({ catalog: "q".repeat(48 * 1024) });
  const provider: OwnerReviewSettingsHandler = async () => ({ kind: "accepted", payload });
  const h = harness({
    provider,
    policy: () => true,
    rows: ["a", "b", "c", "d", "e", "f"],
    bounds: { maxRowsPerPage: 1 },
  });
  try {
    await h.viewer.hello;
    const first = await h.viewer.subscribe();
    await until(() => h.viewer.reviewSettings?.policy !== undefined);
    const before = h.channels.ownerSide.sent.length;
    h.inventory.rows = ["a", "b", "c", "d", "e", "f"].map((id) => ownerRow(id));
    h.inventory.emit();
    const result = await h.viewer.reviewSettings!.load({ hostRunId: RUN });
    assert.ok(result.kind === "owner-result" && result.outcome.kind === "loaded");
    await until(() => (h.viewer.projection.revision ?? 0) > (first.revision ?? 0));
    assert.equal(h.viewer.projection.state, "current");
    const after = h.channels.ownerSide.types();
    assert.ok(after.includes("review_settings_payload_begin"));
    assert.ok(after.includes("review_settings_payload_end"));
    assert.ok(after.filter((type) => type === "snapshot_page").length >= 6);
    const families = h.channels.ownerSide.types().slice(before)
      .filter((type) => type.startsWith("snapshot_") || type.startsWith("review_settings_payload_"))
      .map((type) => (type.startsWith("snapshot_") ? "roster" : "settings"));
    const firstSettings = families.indexOf("settings");
    assert.ok(firstSettings >= 0);
    assert.ok(firstSettings < families.lastIndexOf("roster"),
      "settings progress happened while the roster transfer was still live, so neither lane stalled the other");
    for (const frame of h.channels.ownerSide.frames()) {
      assert.ok(encodeRosterBridgeFrame(frame).length <= 65_536);
    }
  } finally {
    await h.stop();
  }
});

test("Saved and Review-settings transfers both progress on an idle roster", async () => {
  const entries = savedEntries(40);
  let savedListCalls = 0;
  let settingsCalls = 0;
  const baseView = savedView(entries);
  const baseList = baseView.list.bind(baseView);
  const trackingView: OwnerSavedCatalogView = {
    ...baseView,
    list: async (request, signal, guard) => {
      savedListCalls += 1;
      return baseList(request, signal, guard);
    },
  };
  const h = harness({
    policy: () => true,
    savedView: trackingView,
    bounds: { maxRowsPerPage: 1 },
    provider: async () => {
      settingsCalls += 1;
      return { kind: "accepted", payload: json({ catalog: "c".repeat(48 * 1024) }) };
    },
  });
  try {
    await h.viewer.hello;
    await h.viewer.subscribe();
    await until(() => h.viewer.reviewSettings?.policy !== undefined);
    // No roster work remains. Hold the first owner write so both queues are
    // populated before either family can drain.
    h.channels.ownerSide.hold = true;
    const savedPending = h.viewer.saved!.list({
      hostRunId: RUN, query: "", offset: 0, count: entries.length,
    });
    const settingsPending = h.viewer.reviewSettings!.load({ hostRunId: RUN });
    await until(() => savedListCalls === 1 && settingsCalls === 1);
    h.channels.ownerSide.release();
    const [savedResult, settingsResult] = await Promise.all([savedPending, settingsPending]);
    assert.ok(savedResult.kind === "owner-result" && savedResult.outcome.kind === "window");
    assert.equal(savedResult.outcome.entries.length, entries.length);
    assert.ok(settingsResult.kind === "owner-result" && settingsResult.outcome.kind === "loaded");
    const types = h.channels.ownerSide.types();
    const savedPage = types.indexOf("saved_window_page");
    const settingsChunk = types.indexOf("review_settings_payload_chunk");
    assert.ok(savedPage >= 0 && savedPage < types.indexOf("review_settings_payload_end"),
      "the Saved transfer progressed before the settings transfer finished");
    assert.ok(settingsChunk >= 0 && settingsChunk < types.indexOf("saved_window_end"),
      "the settings transfer progressed before the Saved transfer finished");
  } finally {
    await h.stop();
  }
});

test("an unwritable owner payload closes through the bounded channel and the requester stays unknown", async () => {
  const payload = json({ x: "w".repeat(40 * 1024) });
  const h = harness({
    policy: () => true,
    provider: async () => ({ kind: "accepted", payload }),
  });
  h.channels.ownerSide.intercept = (frame) => frame.type === "review_settings_payload_chunk" ? "reject" : undefined;
  try {
    await subscribeReal(h.viewer);
    assert.deepEqual(await h.viewer.reviewSettings!.load({ hostRunId: RUN }), { kind: "unknown" });
    assert.equal(h.ownerDiagnostics.includes("send_failed"), true);
  } finally {
    await h.stop();
  }
});

test("an unoffered Review-settings frame is a protocol violation and reaches no provider", async () => {
  let calls = 0;
  const h = ownerHarness({ policy: () => true, provider: async () => {
    calls += 1;
    return { kind: "accepted" };
  } });
  try {
    h.scripted.hello(false);
    await until(() => h.channels.ownerSide.frames().some((frame) => frame.type === "hello_ack"));
    h.scripted.subscribe();
    await until(() => h.channels.ownerSide.frames().some((frame) => frame.type === "snapshot_end"));
    h.scripted.write({
      type: "review_settings_begin",
      requestId: "1",
      hostRunId: RUN,
      operation: "load",
      sequence: 1,
      bytes: 0,
      sha256: REVIEW_SETTINGS_EMPTY_SHA256,
    });
    await tick();
    assert.equal(calls, 0);
    assert.ok(h.channels.ownerSide.frames().some((frame) => frame.type === "error" && frame.code === "bad_frame"));
  } finally {
    await h.stop();
  }
});

test("the envelope ceiling and fragment count are explicit, while ordinary settings remain representable", () => {
  // The explicit ceiling is above the native 1 MiB configuration limit; this is
  // a transport ceiling, not an editor limit.
  assert.ok(REVIEW_SETTINGS_MAX_BYTES >= 1024 * 1024);
  assert.ok(REVIEW_SETTINGS_MAX_CHUNKS * REVIEW_SETTINGS_FRAGMENT_BYTES >= REVIEW_SETTINGS_MAX_BYTES);
  const nativeSized = json({ native: "n".repeat(1024 * 1024 - 64) });
  const envelope = encodeReviewSettingsEnvelope(nativeSized, 65_536);
  assert.ok(envelope);
  assert.ok(envelope.bytes > 1024 * 1024 - 128);
  assert.equal(Buffer.concat(envelope.chunks).length, envelope.bytes);
  assert.equal(typeof decode(nativeSized), "object");
});
