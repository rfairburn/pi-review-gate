import { randomUUID } from "node:crypto";
import type { SessionViewerState, SessionViewerUpdate, SessionViewerUpdateResult } from "../../src/session-host/instances";
import type { OwningHostInventoryListener, OwningHostInventorySnapshot, OwningHostSessionContentListener, OwningHostSessionContentSnapshot, OwningHostViewerOptions } from "../../src/session-host/owning-host-service";
import type { SessionContentSource } from "../../src/session-host/network/session-content-host";
import type { RosterBridgeInventorySource } from "../../src/session-host/network/roster-bridge-host";
import { fixtureRows } from "./multi-host-contract";
import { ResourceLedger } from "./multi-host-barriers";

/** Synthetic data only. Viewer identity, compare-and-update revision, watch and release ownership are real. */
export class MultiHostSource implements SessionContentSource, RosterBridgeInventorySource {
 private revision = 1;
 private sequence = 0;
 private geometryRevision = 1;
 private cols = 80;
 private rows = 25;
 private marker = "waiting for convergence";
 private readonly inventory = new Map<string, OwningHostInventoryListener>();
 private readonly content = new Map<string, OwningHostSessionContentListener>();
 private readonly viewers = new Map<string, SessionViewerState>();
 constructor(readonly index: number, readonly hostId: string, readonly hostRunId: string, private readonly ledger: ResourceLedger, private readonly changed: () => void) {}
 readInventorySnapshot(): OwningHostInventorySnapshot {
  return { hostRunId: this.hostRunId, revision: this.revision, rows: fixtureRows(this.index, this.hostId, this.hostRunId) };
 }
 watchInventory(listener: OwningHostInventoryListener) {
  const id = randomUUID(); this.inventory.set(id, listener); this.ledger.acquire("inventoryWatch", id, this.hostId);
  return { snapshot: this.readInventorySnapshot(), unsubscribe: () => {
   if (!this.inventory.delete(id)) return;
   this.ledger.release("inventoryWatch", id);
  } };
 }
 publishRoster(revision: 2 | 3): void {
  if (revision !== this.revision + 1) throw new Error("nonsequential roster revision");
  this.revision = revision;
  for (const [id, listener] of this.inventory) { if (this.inventory.has(id)) listener(this.readInventorySnapshot()); }
 }
 private snapshot(): OwningHostSessionContentSnapshot {
  const lines = Array.from({ length: this.rows }, (_, row) => `\x1b[0m${(row === 0 ? this.marker : "").padEnd(this.cols)}\x1b[0m`);
  return { hostRunId: this.hostRunId, sessionId: "shared-live", nativeSession: this.index % 2 === 0 ? { sessionId: this.hostRunId, epoch: 1 } : null,
   sequence: ++this.sequence, geometry: { cols: this.cols, rows: this.rows, revision: this.geometryRevision },
   frame: { cols: this.cols, rows: this.rows, lines, cursor: { column: 0, row: 0, visible: false } },
   inputModes: { kittyFlags: 0, applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: false, mouseTracking: "none", modifyOtherKeys: 0, mouseEncoding: "default" } };
 }
 watchSessionContent(sessionId: string, listener: OwningHostSessionContentListener) {
  if (sessionId !== "shared-live") return undefined;
  const id = randomUUID(); this.content.set(id, listener); this.ledger.acquire("contentWatch", id, this.hostId);
  return { snapshot: this.snapshot(), unsubscribe: () => {
   if (!this.content.delete(id)) return;
   this.ledger.release("contentWatch", id);
  } };
 }
 private publishContent(): void {
  for (const [id, listener] of this.content) { if (this.content.has(id)) listener(this.snapshot()); }
 }
 publishStable(nonce: string): void { this.marker = `stable:${nonce}:${this.hostId}`; this.publishContent(); }
 openViewer(options?: OwningHostViewerOptions): SessionViewerState | undefined {
  // Display-only: never register a clipboard sink or grant input authority.
  if (options !== undefined) return undefined;
  const state = Object.freeze({ viewerId: randomUUID(), sessionId: undefined, cols: undefined, rows: undefined, revision: 1 });
  this.viewers.set(state.viewerId, state); this.ledger.acquire("viewer", state.viewerId, this.hostId); return state;
 }
 readViewer(viewerId: string): SessionViewerState | undefined { return this.viewers.get(viewerId); }
 updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
  const prior = this.viewers.get(viewerId);
  if (prior === undefined) return { applied: false, reason: "unknown-viewer" };
  if (update.expectedRevision !== undefined && update.expectedRevision !== prior.revision) return { applied: false, reason: "stale" };
  const sessionId = update.sessionId === null ? undefined : update.sessionId ?? prior.sessionId;
  if (sessionId !== undefined && sessionId !== "shared-live") return { applied: false, reason: "unknown-session" };
  const cols = update.cols ?? prior.cols; const rows = update.rows ?? prior.rows;
  if ((cols !== undefined && (!Number.isInteger(cols) || cols < 1 || cols > 1000)) ||
   (rows !== undefined && (!Number.isInteger(rows) || rows < 1 || rows > 1000))) return { applied: false, reason: "invalid-geometry" };
  const state = Object.freeze({ viewerId, sessionId, cols, rows, revision: prior.revision + 1 });
  this.viewers.set(viewerId, state);
  if (sessionId !== undefined && cols !== undefined && rows !== undefined) {
   this.cols = cols; this.rows = rows; this.geometryRevision++; this.publishContent();
  }
  this.changed(); return { applied: true, state };
 }
 closeViewer(viewerId: string): boolean {
  if (!this.viewers.delete(viewerId)) return false;
  this.ledger.release("viewer", viewerId); return true;
 }
 viewportReady(): boolean {
  if (this.viewers.size !== 1) return false;
  const viewer = [...this.viewers.values()][0];
  return viewer.sessionId === "shared-live" && viewer.cols !== undefined && viewer.rows !== undefined && viewer.cols >= 80 && viewer.rows >= 25;
 }
}
