import type {
  SessionGeometry,
  SessionViewerState,
  SessionViewerUpdate,
  SessionViewerUpdateResult,
} from "../src/session-host/instances";

/**
 * Shared in-memory copy of the #474 per-session viewer/geometry seam for the
 * session-host controller fixtures. The production `InstanceManager` owns these
 * facts; a fake host that only lists rows still has to answer the same viewer
 * questions, and this keeps one faithful implementation instead of four
 * divergent stubs. It stores viewer facts and per-row geometry only — never a
 * process, status, focus, or input-lease mirror.
 */
export interface FakeViewerHost {
  /** Rows a surface may display: known, launched or launching, and not finished. */
  isViewable(id: string): boolean;
  /** Current canonical geometry of one row, or undefined when the row is unknown. */
  read(id: string): { cols: number; rows: number } | undefined;
  /** Record the canonical geometry a row actually has now. */
  apply(id: string, cols: number, rows: number): void;
}

export class FakeViewerSeam {
  readonly initial: { cols: number; rows: number } = { cols: 80, rows: 24 };
  readonly geometry = new Map<string, SessionGeometry>();
  private readonly viewers = new Map<string, SessionViewerState>();
  private nextViewerId = 1;

  constructor(private readonly host: FakeViewerHost) {}

  /** Seed one row's geometry when the fake creates it (its initial-sizing rule). */
  adopt(id: string, cols: number, rows: number): void {
    this.geometry.set(id, { cols, rows, revision: 0 });
  }

  /** A row the fake no longer has contributes nothing and cannot be targeted. */
  drop(id: string): void {
    this.geometry.delete(id);
    this.retireTargets(id);
  }

  /** Confirmed exit (or removal) ends every surface's participation in a row. */
  retireTargets(sessionId: string): void {
    for (const [viewerId, viewer] of this.viewers) {
      if (viewer.sessionId !== sessionId) continue;
      this.viewers.set(viewerId, { ...viewer, sessionId: undefined, revision: viewer.revision + 1 });
    }
  }

  /** Record a size the fake applied outside the viewer-minima path (host-wide resize). */
  record(id: string, cols: number, rows: number): void {
    const before = this.instanceGeometry(id);
    if (before !== undefined && before.cols === cols && before.rows === rows) return;
    this.geometry.set(id, { cols, rows, revision: (before?.revision ?? 0) + 1 });
  }

  setInitialGeometry(cols: number, rows: number): void {
    this.initial.cols = cols;
    this.initial.rows = rows;
  }

  instanceGeometry(id: string): SessionGeometry | undefined {
    const stored = this.geometry.get(id);
    if (stored !== undefined) return stored;
    const current = this.host.read(id);
    return current === undefined ? undefined : { cols: current.cols, rows: current.rows, revision: 0 };
  }

  openViewer(): SessionViewerState {
    const viewer: SessionViewerState = {
      viewerId: `fake-viewer-${this.nextViewerId++}`,
      sessionId: undefined,
      cols: undefined,
      rows: undefined,
      revision: 1,
    };
    this.viewers.set(viewer.viewerId, viewer);
    return { ...viewer };
  }

  viewerState(viewerId: string): SessionViewerState | undefined {
    const viewer = this.viewers.get(viewerId);
    return viewer === undefined ? undefined : { ...viewer };
  }

  sessionViewers(sessionId: string): SessionViewerState[] {
    return [...this.viewers.values()].filter((viewer) => viewer.sessionId === sessionId).map((viewer) => ({ ...viewer }));
  }

  updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
    const viewer = this.viewers.get(viewerId);
    if (viewer === undefined) return { applied: false, reason: "unknown-viewer" };
    if (update.expectedRevision !== undefined && update.expectedRevision !== viewer.revision) {
      return { applied: false, reason: "stale" };
    }
    const sessionId = update.sessionId === null ? undefined : update.sessionId ?? viewer.sessionId;
    const cols = update.cols === undefined ? viewer.cols : update.cols;
    const rows = update.rows === undefined ? viewer.rows : update.rows;
    if ((cols === undefined) !== (rows === undefined)) return { applied: false, reason: "invalid-geometry" };
    if (sessionId !== undefined && !this.host.isViewable(sessionId)) {
      return { applied: false, reason: "unknown-session" };
    }
    const previous = viewer.sessionId;
    const next: SessionViewerState = { ...viewer, sessionId, cols, rows, revision: viewer.revision + 1 };
    this.viewers.set(viewerId, next);
    if (previous !== undefined) this.recompute(previous);
    if (sessionId !== undefined && sessionId !== previous) this.recompute(sessionId);
    return { applied: true, state: { ...next } };
  }

  closeViewer(viewerId: string): boolean {
    const viewer = this.viewers.get(viewerId);
    if (viewer === undefined) return false;
    this.viewers.delete(viewerId);
    if (viewer.sessionId !== undefined) this.recompute(viewer.sessionId);
    return true;
  }

  /** Independent minima over the surfaces that display one row; none keeps the last size. */
  recompute(sessionId: string): void {
    if (!this.host.isViewable(sessionId)) return;
    let cols: number | undefined;
    let rows: number | undefined;
    for (const viewer of this.viewers.values()) {
      if (viewer.sessionId !== sessionId || viewer.cols === undefined || viewer.rows === undefined) continue;
      if (cols === undefined || viewer.cols < cols) cols = viewer.cols;
      if (rows === undefined || viewer.rows < rows) rows = viewer.rows;
    }
    if (cols === undefined || rows === undefined) return;
    const before = this.instanceGeometry(sessionId);
    if (before !== undefined && before.cols === cols && before.rows === rows) return;
    this.host.apply(sessionId, cols, rows);
    this.geometry.set(sessionId, { cols, rows, revision: (before?.revision ?? 0) + 1 });
  }
}
