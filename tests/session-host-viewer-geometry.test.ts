import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  InstanceManager,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusRegistration,
  type PtyFactory,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { PreparedProfile, ProfilePreparer } from "../src/session-host/profiles";
import { createLocalOwningHostService, type OwningHostManager } from "../src/session-host/owning-host-service";

/**
 * Per-session viewer geometry for the owning session host (issue #474).
 *
 * Everything here is synthetic: an injected PTY, an injected profile preparer,
 * and an in-memory status registrar. No real Pi child, terminal, socket, or
 * clipboard is touched. Each assertion is about which owned row's PTY and
 * terminal surface actually changed size, and about which viewer facts the one
 * manager still holds.
 */

// --- Synthetic launch fixtures (descriptor-only; never executed). ---

function makeRoot(label: string): string {
  // Evidence stays outside the repository tree.
  return realpathSync(mkdtempSync(join(realpathSync(process.env.TMPDIR ?? "/tmp"), `prg-474-${label}-`)));
}

function makePackageFixture(root: string): { packageRoot: string; piExecutable: string } {
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  mkdirSync(join(packageRoot, "scripts"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate fixture; never imported.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic preload fixture.\n", "utf8");
  // The launch descriptor pins the packaged skills the shipped launcher refreshes.
  for (const [skill, files] of [
    ["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
    ["pi-review-gate-execution", ["SKILL.md"]],
    ["pi-review-gate-research", ["SKILL.md"]],
    ["pi-review-gate-completion", ["SKILL.md"]],
  ] as const) {
    for (const file of files) {
      const path = join(packageRoot, "skills", skill, ...file.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, `${skill}/${file}\n`, "utf8");
    }
  }
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n", "utf8");
  chmodSync(piExecutable, 0o755);
  return { packageRoot, piExecutable };
}

class SyntheticPty implements InstancePty {
  static #nextPid = 530_000;
  readonly pid: number;
  cols: number;
  rows: number;
  readonly spawnDescriptor: InstanceSpawnDescriptor;
  readonly resizeCalls: { cols: number; rows: number }[] = [];
  resizeError: Error | undefined;
  exited = false;
  readonly #dataListeners: ((data: string) => void)[] = [];
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SyntheticPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
    this.spawnDescriptor = descriptor;
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose: () => { this.#dataListeners.splice(this.#dataListeners.indexOf(listener), 1); } };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => { this.#exitListeners.splice(this.#exitListeners.indexOf(listener), 1); } };
  }

  on(): void { /* the read-error channel is not exercised here */ }

  removeListener(): void { /* the read-error channel is not exercised here */ }

  write(): void { /* input bytes are not the subject of these cases */ }

  resize(columns: number, rows: number): void {
    if (this.resizeError !== undefined) throw this.resizeError;
    this.resizeCalls.push({ cols: columns, rows });
    this.cols = columns;
    this.rows = rows;
  }

  kill(signal?: string): void {
    if (signal === "SIGKILL" || signal === "SIGTERM") this.emitExit(0);
  }

  pause(): void { /* not exercised */ }

  resume(): void { /* not exercised */ }

  emitExit(exitCode: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
  }
}

const syntheticRegistrar: StatusRegistrar = {
  register(instanceId: string): InstanceStatusRegistration {
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: `tok-${randomUUID()}`,
        instanceId,
        generation: randomUUID(),
      },
      release(): void { /* nothing is owned */ },
    };
  },
};

/** Host role markers must never reach a synthetic launch descriptor. */
const HOST_ROLE_ENV_KEYS = ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"] as const;

function cleanTestEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of HOST_ROLE_ENV_KEYS) delete env[key];
  return env;
}

/** Descriptor-only preparer over an existing agent directory (the real registry is covered elsewhere). */
function syntheticPreparer(agentDir: string): ProfilePreparer {
  return {
    prepare(options: { workspace: string; profile?: string }): PreparedProfile {
      return {
        workspace: resolve(options.workspace),
        agentDir,
        created: false,
        release(): void { /* nothing is owned */ },
      };
    },
  };
}

interface Fixture {
  readonly root: string;
  readonly manager: InstanceManager;
  readonly service: ReturnType<typeof createLocalOwningHostService>;
  /** Create one synthetic row and return its id. */
  createRow(label: string): Promise<string>;
  /** The exact synthetic PTY this row's launch spawned. */
  ptyFor(id: string): SyntheticPty;
  /** The geometry the host would actually extract for one row. */
  surfaceSize(id: string): { cols: number; rows: number };
  close(): Promise<void>;
}

async function fixture(options: { cols?: number; rows?: number } = {}): Promise<Fixture> {
  const root = makeRoot("geometry");
  const pkg = makePackageFixture(root);
  const workspaceRoot = join(root, "workspaces");
  mkdirSync(workspaceRoot, { recursive: true });
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  // Legacy profile launches require the registry-owned review-gate config to exist;
  // this fixture never reads it, it only satisfies the launch descriptor's checks.
  writeFileSync(join(agentDir, "review-gate.json"), "{}\n", "utf8");
  // Each row gets its own workspace, which identifies its spawned PTY exactly.
  const ptysByWorkspace = new Map<string, SyntheticPty>();
  const ptyFactory: PtyFactory = (descriptor) => {
    const pty = new SyntheticPty(descriptor);
    ptysByWorkspace.set(descriptor.cwd, pty);
    return pty;
  };
  const manager = new InstanceManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: syntheticRegistrar,
    nativeSetup: false,
    profileRegistry: syntheticPreparer(agentDir),
    args: [],
    env: cleanTestEnv(),
    cols: options.cols ?? DEFAULT_INSTANCE_COLS,
    rows: options.rows ?? DEFAULT_INSTANCE_ROWS,
    getSupportedKeyboardFlags: () => 7,
    ptyFactory,
  });
  const service = createLocalOwningHostService({
    createManager: () => manager as unknown as OwningHostManager,
    teardownRequested: () => false,
  });
  service.openManager({
    packageRoot: pkg.packageRoot,
    piExecutable: pkg.piExecutable,
    statusRegistrar: syntheticRegistrar,
  } as InstanceManagerOptions);
  let counter = 0;
  const workspaceFor = (label: string): string => {
    counter += 1;
    const path = join(workspaceRoot, `${label}-${counter}`);
    mkdirSync(path, { recursive: true });
    return path;
  };
  return {
    root,
    manager,
    service,
    createRow: async (label) => {
      const id = await manager.create({ workspace: workspaceFor(label) });
      const view = manager.list().find((candidate) => candidate.id === id);
      assert.equal(view?.lifecycle, "alive", `the synthetic row launched (error: ${view?.error ?? "none"})`);
      return id;
    },
    ptyFor: (id) => {
      const view = manager.list().find((candidate) => candidate.id === id);
      assert.ok(view, `row ${id} is not listed`);
      const pty = ptysByWorkspace.get(view.workspace);
      assert.ok(pty, `no synthetic PTY was spawned for row ${id}`);
      return pty;
    },
    surfaceSize: (id) => {
      const surface = manager.surface(id);
      assert.ok(surface, `row ${id} has no terminal surface`);
      const frame = surface.frame();
      return { cols: frame.cols, rows: frame.rows };
    },
    close: async () => {
      await manager.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("two viewers of one session set independent minima and resize only that row", async () => {
  const owner = await fixture();
  try {
    const viewed = await owner.createRow("viewed");
    const sibling = await owner.createRow("sibling");
    const siblingSurfaceBefore = owner.surfaceSize(sibling);
    const siblingPty = owner.ptyFor(sibling);
    const siblingResizesBefore = siblingPty.resizeCalls.length;

    const wide = owner.service.openViewer();
    const narrow = owner.service.openViewer();
    assert.ok(wide && narrow);
    assert.ok(owner.service.updateViewer(wide.viewerId, { sessionId: viewed, cols: 100, rows: 40 }).applied);
    assert.ok(owner.service.updateViewer(narrow.viewerId, { sessionId: viewed, cols: 80, rows: 50 }).applied);

    // Minimum columns and minimum rows are taken independently: 100x40 and
    // 80x50 give 80x40, not the smaller viewer's own 80x50.
    assert.deepEqual(owner.service.readSessionGeometry(viewed), { cols: 80, rows: 40, revision: 2 });
    assert.deepEqual({ cols: owner.ptyFor(viewed).cols, rows: owner.ptyFor(viewed).rows }, { cols: 80, rows: 40 });
    assert.deepEqual(owner.surfaceSize(viewed), { cols: 80, rows: 40 });

    // A sibling session and its PTY were never touched, and it keeps the
    // initial-sizing rule because nobody is viewing it.
    assert.deepEqual(owner.surfaceSize(sibling), siblingSurfaceBefore);
    assert.equal(siblingPty.resizeCalls.length, siblingResizesBefore);
    assert.deepEqual(owner.service.readSessionGeometry(sibling), {
      cols: DEFAULT_INSTANCE_COLS, rows: DEFAULT_INSTANCE_ROWS, revision: 0,
    });

    // Both surfaces stay registered on the same session, and input stays
    // addressed-only rather than leased to whichever viewer arrived last.
    assert.equal(owner.service.readSessionViewers(viewed).length, 2);
    owner.manager.write(viewed, "input still reaches the addressed row");
  } finally {
    await owner.close();
  }
});

test("the last viewer leaving keeps the last size and a later smaller viewer changes it", async () => {
  const owner = await fixture();
  try {
    const row = await owner.createRow("solo");
    const first = owner.service.openViewer();
    const second = owner.service.openViewer();
    assert.ok(first && second);
    owner.service.updateViewer(first.viewerId, { sessionId: row, cols: 100, rows: 40 });
    owner.service.updateViewer(second.viewerId, { sessionId: row, cols: 80, rows: 50 });
    assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 80, rows: 40, revision: 2 });

    // Removing one viewer recomputes the minima over the viewers that remain.
    assert.equal(owner.service.closeViewer(second.viewerId), true);
    assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 100, rows: 40, revision: 3 });

    // Removing the last viewer keeps the last canonical size: no reset to a
    // default, no stop, and no resize call at all.
    const pty = owner.ptyFor(row);
    const resizesBefore = pty.resizeCalls.length;
    assert.equal(owner.service.closeViewer(first.viewerId), true);
    assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 100, rows: 40, revision: 3 });
    assert.equal(pty.resizeCalls.length, resizesBefore);
    assert.equal(pty.exited, false, "the owned child keeps running with its last size");

    // A later viewer smaller than the retained size does change it.
    const third = owner.service.openViewer();
    assert.ok(third);
    owner.service.updateViewer(third.viewerId, { sessionId: row, cols: 60, rows: 20 });
    assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 60, rows: 20, revision: 4 });
  } finally {
    await owner.close();
  }
});

test("metadata-only surfaces and other sessions' viewers contribute no dimensions", async () => {
  const owner = await fixture();
  try {
    const row = await owner.createRow("meta");
    const other = await owner.createRow("other");
    const before = owner.service.readSessionGeometry(row);
    const pty = owner.ptyFor(row);
    const resizesBefore = pty.resizeCalls.length;

    const metadata = owner.service.openViewer();
    assert.ok(metadata);
    assert.ok(owner.service.updateViewer(metadata.viewerId, { sessionId: row }).applied);
    assert.deepEqual(owner.service.readSessionViewers(row).map((viewer) => viewer.viewerId), [metadata.viewerId]);
    assert.deepEqual(owner.service.readSessionGeometry(row), before);

    // A viewer selecting a different session sizes that session, never this one.
    const otherViewer = owner.service.openViewer();
    assert.ok(otherViewer);
    owner.service.updateViewer(otherViewer.viewerId, { sessionId: other, cols: 42, rows: 12 });
    assert.deepEqual(owner.service.readSessionGeometry(row), before);
    assert.deepEqual(owner.service.readSessionGeometry(other), { cols: 42, rows: 12, revision: 1 });
    assert.equal(pty.resizeCalls.length, resizesBefore);

    // Half a geometry (columns without rows) is refused, never guessed at.
    assert.deepEqual(owner.service.updateViewer(metadata.viewerId, { cols: 90 }), { applied: false, reason: "invalid-geometry" });
    assert.deepEqual(owner.service.readSessionGeometry(row), before);
  } finally {
    await owner.close();
  }
});

test("initial sizing follows the host pane for later rows and resizes nothing that exists", async () => {
  const owner = await fixture();
  try {
    const existing = await owner.createRow("existing");
    const existingBefore = owner.service.readSessionGeometry(existing);
    const existingPty = owner.ptyFor(existing);
    const resizesBefore = existingPty.resizeCalls.length;

    owner.service.setInitialGeometry(120, 30);

    // A row nobody has ever viewed keeps the existing initial-sizing rule.
    const created = await owner.createRow("new-background");
    assert.deepEqual({ cols: owner.ptyFor(created).cols, rows: owner.ptyFor(created).rows }, { cols: 120, rows: 30 });
    assert.deepEqual(owner.surfaceSize(created), { cols: 120, rows: 30 });

    // Existing rows — including one nobody is viewing — keep their last size.
    assert.deepEqual(owner.service.readSessionGeometry(existing), existingBefore);
    assert.equal(existingPty.resizeCalls.length, resizesBefore);
  } finally {
    await owner.close();
  }
});

test("a viewer's participation ends when its row exits or is removed and cannot be resurrected", async () => {
  const owner = await fixture();
  try {
    const row = await owner.createRow("exiting");
    const viewer = owner.service.openViewer();
    assert.ok(viewer);
    owner.service.updateViewer(viewer.viewerId, { sessionId: row, cols: 90, rows: 30 });
    const revisionAfterSelect = owner.service.readViewer(viewer.viewerId)?.revision;
    assert.equal(typeof revisionAfterSelect, "number");

    // A confirmed exit retires the surface's target: nothing may keep
    // displaying or sizing a finished child, and its size stays as it was.
    owner.ptyFor(row).emitExit(0);
    const retired = owner.service.readViewer(viewer.viewerId);
    assert.equal(retired?.sessionId, undefined);
    assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 90, rows: 30, revision: 1 });
    assert.ok((retired?.revision ?? 0) > (revisionAfterSelect ?? 0),
      "retiring the target advances the surface revision so older writers are stale");

    // A writer still holding the pre-exit revision is refused instead of
    // resurrecting the finished view.
    assert.deepEqual(
      owner.service.updateViewer(viewer.viewerId, { sessionId: row, cols: 90, rows: 30, expectedRevision: revisionAfterSelect }),
      { applied: false, reason: "stale" },
    );
    // Even an unfenced writer cannot make a finished row a content target.
    assert.deepEqual(
      owner.service.updateViewer(viewer.viewerId, { sessionId: row, cols: 90, rows: 30 }),
      { applied: false, reason: "unknown-session" },
    );

    // Removal retires it too, and no surface can target a removed row.
    assert.equal(owner.manager.closeExited(row), true);
    assert.equal(owner.service.readSessionGeometry(row), undefined);
    const late = owner.service.openViewer();
    assert.ok(late);
    assert.deepEqual(
      owner.service.updateViewer(late.viewerId, { sessionId: row, cols: 80, rows: 24 }),
      { applied: false, reason: "unknown-session" },
    );
  } finally {
    await owner.close();
  }
});

test("a stale viewer write cannot overwrite a later selection and ids are never reused", async () => {
  const owner = await fixture();
  try {
    const first = await owner.createRow("first");
    const second = await owner.createRow("second");
    const viewer = owner.service.openViewer();
    assert.ok(viewer);
    const initial = owner.service.updateViewer(viewer.viewerId, { sessionId: first, cols: 100, rows: 40 });
    assert.equal(initial.applied, true);
    if (!initial.applied) throw new Error("unreachable");

    // The operator selects another session; an in-flight completion for the
    // first one arrives afterwards.
    const selected = owner.service.updateViewer(viewer.viewerId, { sessionId: second, cols: 100, rows: 40 });
    assert.equal(selected.applied, true);
    assert.deepEqual(
      owner.service.updateViewer(viewer.viewerId, { sessionId: first, expectedRevision: initial.state.revision }),
      { applied: false, reason: "stale" },
    );
    assert.equal(owner.service.readViewer(viewer.viewerId)?.sessionId, second);
    // The abandoned session keeps the size its viewer set and is not resized
    // again by the stale write.
    assert.deepEqual(owner.service.readSessionGeometry(first), { cols: 100, rows: 40, revision: 1 });
    assert.deepEqual(owner.service.readSessionGeometry(second), { cols: 100, rows: 40, revision: 1 });

    // A closed surface is gone for good: its id never resolves again, and a
    // fresh registration gets a different id.
    assert.equal(owner.service.closeViewer(viewer.viewerId), true);
    assert.deepEqual(owner.service.updateViewer(viewer.viewerId, { sessionId: second }), { applied: false, reason: "unknown-viewer" });
    const replacement = owner.service.openViewer();
    assert.ok(replacement);
    assert.notEqual(replacement.viewerId, viewer.viewerId);
  } finally {
    await owner.close();
  }
});

test("disposal drops every viewer fact and refuses further viewer work", async () => {
  const owner = await fixture();
  try {
    const row = await owner.createRow("disposed");
    const viewer = owner.service.openViewer();
    assert.ok(viewer);
    owner.service.updateViewer(viewer.viewerId, { sessionId: row, cols: 88, rows: 28 });
    await owner.manager.dispose();
    assert.equal(owner.service.readViewer(viewer.viewerId), undefined);
    assert.deepEqual(owner.service.updateViewer(viewer.viewerId, { sessionId: row }), { applied: false, reason: "disposed" });
    assert.equal(owner.service.openViewer(), undefined);
    assert.equal(owner.service.readSessionViewers(row).length, 0);
  } finally {
    rmSync(owner.root, { recursive: true, force: true });
  }
});

test("a per-row geometry failure stays on its own row and siblings keep running", async () => {
  const owner = await fixture();
  try {
    const failing = await owner.createRow("failing");
    const healthy = await owner.createRow("healthy");
    const healthyBefore = owner.service.readSessionGeometry(healthy);
    owner.ptyFor(failing).resizeError = new Error("synthetic native resize failure");

    const viewer = owner.service.openViewer();
    assert.ok(viewer);
    owner.service.updateViewer(viewer.viewerId, { sessionId: failing, cols: 70, rows: 21 });

    const failedView = owner.manager.list().find((view) => view.id === failing);
    assert.equal(failedView?.error, "session-host: instance PTY resize failed");
    // The failed row is no longer a displayable target, and its sibling is intact.
    assert.deepEqual(
      owner.service.updateViewer(viewer.viewerId, { sessionId: failing, cols: 70, rows: 21 }),
      { applied: false, reason: "unknown-session" },
    );
    assert.deepEqual(owner.service.readSessionGeometry(healthy), healthyBefore);
    assert.equal(owner.ptyFor(healthy).exited, false);
  } finally {
    await owner.close();
  }
});
