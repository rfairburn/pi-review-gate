/** Opt-in 64-host, real production TLS/protocol fixture. No Main, owner mutations, or native IO. */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { PeerByteChannel } from "../../src/session-host/network/channel";
import { generatePeerIdentity } from "../../src/session-host/network/identity";
import { createPeerHost, type PeerHost } from "../../src/session-host/network/peer-host";
import { createRosterBridgeHost, type RosterBridgeChannelBinding, type RosterBridgeHost } from "../../src/session-host/network/roster-bridge-host";
import { createSessionContentHost, type SessionContentChannelBinding, type SessionContentHost } from "../../src/session-host/network/session-content-host";
import { createInMemoryAcceptedPeerStore, createInMemoryDirectionalGrantStore } from "../../src/session-host/network/trust";
import { HOST_COUNT, LABEL, MAX_RECORD_BYTES, parseOptions, validateOptions, validateReady, type HostDescriptor, type MultiHostOptions, type ReadyRecord } from "./multi-host-contract";
import { bounded, ConvergenceBarriers, listenOwned, ResourceLedger, settleCleanup, type ResourceKind } from "./multi-host-barriers";
import { MultiHostSource } from "./multi-host-source";

const DEADLINES = { readiness: 60_000, phase: 60_000, overall: 900_000, cleanup: 15_000 };
interface OwnedHost { peer: PeerHost; roster: RosterBridgeHost; content: SessionContentHost; source: MultiHostSource }
interface BindingRecord { id: string; hostId: string; lane: "app" | "content"; binding: RosterBridgeChannelBinding | SessionContentChannelBinding; subscription: boolean }
export function writeRecord(record: object): void {
 const line = JSON.stringify(record);
 if (Buffer.byteLength(line, "utf8") + 1 > MAX_RECORD_BYTES) throw new Error("fixture record exceeds 64KiB");
 process.stdout.write(`${line}\n`);
}

export async function runMultiHostFixture(options: MultiHostOptions): Promise<number> {
 validateOptions(options);
 const owned: OwnedHost[] = []; const descriptors: HostDescriptor[] = [];
 const bindings = new Map<string, BindingRecord>(); const problems = new Set<string>();
 let queued = false; let finishing = false; let startupCancelled = false;
 let barriers: ConvergenceBarriers | undefined;
 let phaseTimer: ReturnType<typeof setTimeout> | undefined;
 let forbiddenOwnerRequests = 0; let forbiddenInputCopyRequests = 0; let rejectedPairings = 0;
 let listenerCleanup = false;
 let listenersClosed = 0;
 let listenersBound = 0;
 const emptyWaiters = new Set<() => void>();
 let finish!: (reason?: string) => Promise<number>;
 let resolveResult!: (code: number) => void;
 const result = new Promise<number>((resolve) => { resolveResult = resolve; });
 const changed = (event?: { kind: ResourceKind; acquired: boolean }): void => {
  if (!finishing && event !== undefined) barriers?.resourceChanged(event);
  if (queued) return; queued = true;
  queueMicrotask(() => {
   queued = false;
   for (const record of bindings.values()) syncSubscription(record);
   if (ledger.empty) for (const wake of emptyWaiters) wake();
   if (finishing || barriers === undefined) return;
   for (const action of barriers.advance((id) => owned.find((host) => host.source.hostId === id)?.source.viewportReady() === true)) {
    if (action.phase === "stable") owned.find((host) => host.source.hostId === action.hostId)!.source.publishStable(options.nonce);
    else for (const host of owned) host.source.publishRoster(action.phase === "roster-2" ? 2 : 3);
    writeRecord({ event: "checkpoint", nonce: options.nonce, ...action });
    armPhase();
   }
   if (barriers.problems.size > 0) void finish("convergence failed");
  });
 };
 const ledger = new ResourceLedger(changed);
 const syncSubscription = (record: BindingRecord): void => {
  // Observe protocol subscription ownership independently of channels, watches, viewers and binding settlement.
  const active = record.lane === "content" ? record.binding.subscriptionId !== null : record.binding.subscribed;
  if (active === record.subscription) return;
  record.subscription = active;
  if (active) ledger.acquire(record.lane === "app" ? "appSubscription" : "contentSubscription", record.id, record.hostId);
  else ledger.release(record.lane === "app" ? "appSubscription" : "contentSubscription", record.id);
 };
 const armPhase = (): void => {
  clearTimeout(phaseTimer);
  phaseTimer = setTimeout(() => { void finish("phase deadline exceeded"); }, DEADLINES.phase);
 };
 const observe = (channel: PeerByteChannel, id: string, hostId: string): PeerByteChannel => {
  const lane = channel.lane;
  return {
   peerKey: channel.peerKey, lane, label: channel.label,
   get bufferedAmount() { return channel.bufferedAmount; }, closed: channel.closed,
   send: (bytes) => channel.send(bytes), close: () => channel.close(),
   onMessage: (handler) => {
    const handlerKind = lane === "app" ? "appHandler" : "contentHandler";
    const detach = channel.onMessage((bytes) => {
     try {
      // Observe only a bounded frame discriminator; production still decodes and handles the original bytes.
      let type: unknown;
      try { type = (JSON.parse(bytes.toString("utf8")) as { type?: unknown }).type; } catch { /* production refuses malformed frames */ }
      if (typeof type === "string") {
       if (["close_request", "create_request", "rename_request", "saved_resume_request", "saved_delete_request"].includes(type)) forbiddenOwnerRequests++;
       if (/^(input|copy)(_|$)/.test(type)) forbiddenInputCopyRequests++;
      }
      handler(bytes);
     } finally {
      const record = bindings.get(id); if (record !== undefined) syncSubscription(record);
      changed();
     }
    });
    ledger.acquire(handlerKind, id, hostId); let attached = true;
    return () => { if (!attached) return; detach(); attached = false; ledger.release(handlerKind, id); };
   },
  };
 };
 const attach = (host: OwnedHost, channel: PeerByteChannel): void => {
  const id = randomUUID(); const hostId = host.source.hostId; const lane = channel.lane;
  ledger.acquire(lane === "app" ? "appChannel" : "contentChannel", id, hostId);
  void channel.closed.then(() => { ledger.release(lane === "app" ? "appChannel" : "contentChannel", id); });
  if (channel.peerKey.keyId !== options.clientKeyId || channel.label !== options.clientLabel) {
   problems.add("admitted channel identity mismatch"); void channel.close(); return;
  }
  const observed = observe(channel, id, hostId);
  const binding = lane === "app" ? host.roster.attach(observed) : host.content.attach(observed);
  const record: BindingRecord = { id, hostId, lane, binding, subscription: false };
  bindings.set(id, record); ledger.acquire(lane === "app" ? "appBinding" : "contentBinding", id, hostId);
  syncSubscription(record);
  void binding.closed.then(() => {
   syncSubscription(record);
   if (record.subscription) { problems.add("settled binding retained subscription"); return; }
   ledger.release(lane === "app" ? "appBinding" : "contentBinding", id); bindings.delete(id);
  }, () => { problems.add("binding retirement uncertain"); changed(); });
 };
 const waitClientEmpty = async (): Promise<void> => {
  if (ledger.empty) return;
  let wake!: () => void;
  const empty = new Promise<void>((resolve) => { wake = resolve; emptyWaiters.add(wake); });
  try { await bounded(empty, DEADLINES.cleanup, "client resource retirement"); }
  finally { emptyWaiters.delete(wake); }
 };
 const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });
 let finishPromise: Promise<number> | undefined;
 finish = (reason?: string): Promise<number> => {
  if (finishPromise !== undefined) return finishPromise;
  finishing = true; startupCancelled = true; clearTimeout(phaseTimer); clearTimeout(overallTimer); clearTimeout(readinessTimer);
  if (reason !== undefined) problems.add(reason);
  finishPromise = (async () => {
   let clientRetirementUncertain = false;
   if (reason === undefined) {
    try { await waitClientEmpty(); } catch { clientRetirementUncertain = true; problems.add("client resource retirement deadline exceeded"); }
   }
   const clientProblems = barriers?.clientCleanupProblems() ?? ["startup incomplete"];
   clientProblems.forEach((problem) => problems.add(problem));
   // Snapshot before invoking any host-owned stop: cleanup cannot manufacture evidence of client retirement.
   const clientCleanupBeforeListenerStop = clientProblems.length === 0 && ledger.empty;
   const beforeStop = ledger.counters();
   writeRecord({ event: "client-cleanup-before-listener-stop", version: 1, nonce: options.nonce, ok: clientCleanupBeforeListenerStop, counters: beforeStop });
   const bindingFailures = await settleCleanup(owned.flatMap((host) => [() => host.roster.stopAll(), () => host.content.stopAll()]), DEADLINES.cleanup);
   bindingFailures.forEach((problem) => problems.add(problem));
   const listenerFailures = await settleCleanup(owned.map((host) => async () => { await host.peer.close(); listenersClosed++; }), DEADLINES.cleanup);
   listenerFailures.forEach((problem) => problems.add(problem));
   listenerCleanup = listenerFailures.length === 0;
   if (!ledger.empty) problems.add("resources remain after listener cleanup");
   if (forbiddenOwnerRequests !== 0 || forbiddenInputCopyRequests !== 0 || rejectedPairings !== 0) problems.add("forbidden requests or unexpected pairing observed");
   stdin.removeAllListeners(); stdin.close(); process.stdin.pause();
   const ok = problems.size === 0 && clientCleanupBeforeListenerStop && listenerCleanup;
   const ownedCleanupUncertain = !listenerCleanup || !ledger.empty || bindingFailures.length > 0;
   const uncertain = clientRetirementUncertain || ownedCleanupUncertain;
   const forced = ownedCleanupUncertain && require.main === module;
   writeRecord({ event: "report", version: 1, nonce: options.nonce, ok, problems: [...problems].slice(0, 64),
    selectedHosts: barriers?.selected.length ?? 0, rosterRevision: barriers?.revision ?? 1,
    forbiddenOwnerRequests, forbiddenInputCopyRequests, rejectedPairings, clientCleanupBeforeListenerStop, listenerCleanup,
    beforeListenerStop: beforeStop, counters: ledger.counters(),
    listenerOwnership: { current: owned.length - listenersClosed, acquired: owned.length, released: listenersClosed, peak: owned.length, bound: listenersBound },
    retiringOverlapObserved: ledger.counters().contentBinding.peak > 1, forced, uncertain });
   // A timed-out cleanup is never normal settlement. Only the CLI may force a nonzero exit after flushing its failure report.
   if (forced) {
    await new Promise<void>((resolve) => { process.stdout.write("", () => resolve()); });
    process.exit(2);
   }
   const code = ok ? 0 : 2; resolveResult(code); return code;
  })();
  return finishPromise;
 };
 const overallTimer = setTimeout(() => { void finish("overall deadline exceeded"); }, DEADLINES.overall);
 const readinessTimer = setTimeout(() => { void finish("readiness deadline exceeded"); }, DEADLINES.readiness);
 stdin.on("line", (line) => { if (line === "report") void finish(); else void finish("unexpected stdin command"); });
 stdin.on("close", () => { if (!finishing) void finish("stdin closed without report"); });
 const start = async (): Promise<void> => {
  for (let index = 0; index < HOST_COUNT; index++) {
   const identity = await generatePeerIdentity(LABEL);
   if (startupCancelled) return;
   const hostId = randomUUID(); const hostRunId = randomUUID();
   const accepted = createInMemoryAcceptedPeerStore(); const grants = createInMemoryDirectionalGrantStore();
   const authorized = (key: { keyId: string }): boolean => {
    const record = accepted.get(key.keyId); const grant = grants.get(key.keyId);
    return key.keyId === options.clientKeyId && record?.receiverKeyId === identity.key.keyId && record.label === options.clientLabel &&
     grant?.receiverKeyId === identity.key.keyId && grant.direction === "peer->host" && grant.capability === "app";
   };
   const source = new MultiHostSource(index, hostId, hostRunId, ledger, changed);
   const diagnostic = (event: { code: string }): void => {
    if (/uncertain|protocol_violation|send_failed|send_timeout|viewport_failed|snapshot_failed|source_unavailable|run_changed|authorization_refused/.test(event.code)) problems.add(`protocol ${event.code}`);
    // Capture subscription acquisition at the production diagnostic, including an acquisition that fails later in the same handler.
    for (const record of bindings.values()) if (record.hostId === hostId) syncSubscription(record);
    changed();
   };
   const roster = createRosterBridgeHost({ inventory: source, authorizePeer: authorized, onDiagnostic: diagnostic });
   const content = createSessionContentHost({ source, authorizePeer: authorized, onDiagnostic: diagnostic });
   let host!: OwnedHost;
   const peer = createPeerHost({ identity, acceptedPeers: accepted, grants,
    onPairingRequest: (request) => {
     if (request.peerKey.keyId === options.clientKeyId && request.label === options.clientLabel) request.approve();
     else { rejectedPairings++; request.deny(); }
    },
    onAppChannel: (channel) => attach(host, channel), onContentChannel: (channel) => attach(host, channel),
   });
   host = { peer, roster, content, source };
   const bound = await listenOwned(owned, host);
   listenersBound++;
   if (startupCancelled) return;
   descriptors.push({ hostId, hostRunId, hostKeyId: identity.key.keyId, hostLabel: LABEL, port: bound.port });
  }
  if (startupCancelled) return;
  const ready: ReadyRecord = { event: "ready", version: 1, ...options, listenHost: "127.0.0.1", hosts: descriptors };
  validateReady(ready, options); barriers = new ConvergenceBarriers(descriptors.map((host) => host.hostId), ledger);
  clearTimeout(readinessTimer); writeRecord(ready); armPhase(); changed();
 };
 void start().catch(() => { void finish("startup failed"); });
 return result;
}
if (require.main === module) {
 void (async () => {
  try { process.exitCode = await runMultiHostFixture(parseOptions(process.argv.slice(2))); }
  catch { process.stderr.write("multi-host fixture failed\n"); process.exitCode = 1; }
 })();
}
