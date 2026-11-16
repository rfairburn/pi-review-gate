import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NativeStatusObserver } from "../src/session-host/instances";
import {
  createNativeStatusObserver,
  createNativeStatusObserverFactory,
} from "../src/session-host/native-observer-factory";
import type { NativeStatusObservation } from "../src/session-host/native-status";

test("Claude factory supplies the actual source applicability and unknown initial observation", () => {
  const observations: NativeStatusObservation[] = [];
  const observer = createNativeStatusObserver({ rowId: "claude-row", backend: "claude", emit: (value) => observations.push(value) });
  try {
    assert.deepEqual(observer.support, {
      agent: "supported", input: "supported", tasks: "supported", shells: "supported", activity: "supported",
    });
    observer.invalidate();
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.busy, null);
    assert.equal(observations[0]!.pendingInput, null);
    assert.equal(observations[0]!.activeTasks, null);
    assert.equal(observations[0]!.activeShells, null);
    assert.deepEqual(observations[0]!.activity, []);
  } finally {
    observer.dispose();
  }
});

test("Codex factory distinguishes unsupported census categories from supported unknown values", () => {
  const observations: NativeStatusObservation[] = [];
  const observer = createNativeStatusObserver({ rowId: "codex-row", backend: "codex", emit: (value) => observations.push(value) });
  try {
    assert.deepEqual(observer.support, {
      agent: "supported", input: "unsupported", tasks: "unsupported", shells: "unsupported", activity: "supported",
    });
    observer.acceptFailure({ backend: "codex", reason: "delivery-refused" });
    assert.equal(observations.length, 1);
    assert.equal(observations[0]!.busy, null);
    assert.equal(observations[0]!.pendingInput, null);
    assert.equal(observations[0]!.activeTasks, null);
    assert.equal(observations[0]!.activeShells, null);
    assert.deepEqual(observations[0]!.support, observer.support);
  } finally {
    observer.dispose();
  }
});

test("factory instances retain independent callbacks and reject the other backend's events", () => {
  const claude: NativeStatusObservation[] = [];
  const codex: NativeStatusObservation[] = [];
  const a = createNativeStatusObserver({ rowId: "a", backend: "claude", emit: (value) => claude.push(value) });
  const b = createNativeStatusObserver({ rowId: "b", backend: "codex", emit: (value) => codex.push(value) });
  try {
    a.acceptFailure({ backend: "codex", reason: "input-invalid" });
    b.acceptFailure({ backend: "claude", reason: "input-invalid" });
    assert.equal(claude.length, 0);
    assert.equal(codex.length, 0);
    a.invalidate();
    assert.equal(claude.length, 1);
    assert.equal(codex.length, 0);
    b.invalidate();
    assert.equal(codex.length, 1);
  } finally {
    a.dispose();
    b.dispose();
  }
});

test("factory disposal is idempotent and later calls cannot emit", () => {
  for (const backend of ["claude", "codex"] as const) {
    const observations: NativeStatusObservation[] = [];
    const observer = createNativeStatusObserver({ rowId: backend, backend, emit: (value) => observations.push(value) });
    observer.dispose();
    observer.dispose();
    observer.invalidate();
    observer.acceptHook({ backend, hook_event_name: "SessionEnd", session_id: "old-session" });
    observer.acceptFailure({ backend, reason: "input-invalid" });
    assert.equal(observations.length, 0);
  }
});

test("only the Claude source can state a launch baseline; Codex keeps its unknown-until-record path", () => {
  const observations: NativeStatusObservation[] = [];
  const claude: NativeStatusObserver = createNativeStatusObserver({
    rowId: "claude-row", backend: "claude", emit: (value) => observations.push(value),
  });
  const codex: NativeStatusObserver = createNativeStatusObserver({
    rowId: "codex-row", backend: "codex", emit: (value) => observations.push(value),
  });
  try {
    assert.equal(typeof claude.observeOwnedStartup, "function");
    assert.equal(codex.observeOwnedStartup, undefined, "the Codex route states no launch baseline today");

    claude.observeOwnedStartup!();
    assert.equal(observations.length, 1, "the baseline is published, not held back for a hook");
    const baseline = observations[0]!;
    assert.equal(baseline.busy, false);
    assert.equal(baseline.pendingInput, false);
    assert.equal(baseline.activeTasks, 0);
    assert.equal(baseline.activeShells, 0);
    assert.deepEqual(baseline.activity, ["Ready"]);
    assert.deepEqual(baseline.support, claude.support);
  } finally {
    claude.dispose();
    codex.dispose();
  }
});

const RESTORED_ID = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "prg-observer-factory-")));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

test("the factory forwards the owner-private restoration inputs to the Claude source, which proves its own resume", () => {
  withWorkspace((workspace) => {
    for (const factory of [createNativeStatusObserver, createNativeStatusObserverFactory({ ownedCodexBackend: true })]) {
      const observations: NativeStatusObservation[] = [];
      const identities: (string | null)[] = [];
      const observer = factory({
        rowId: "claude-row",
        backend: "claude",
        emit: (value) => { observations.push(value); return { accepted: true } as never; },
        workspace,
        resumeConversationId: RESTORED_ID,
        emitConversationIdentity: (id) => { identities.push(id); return true; },
      }) as NativeStatusObserver;
      try {
        observer.observeOwnedStartup?.();
        assert.equal(observations.length, 0, "an unproved restored Claude spawn states no idle or empty baseline");
        assert.deepEqual(identities, [], "the admitted id is an expectation, never reported unproved");
        observer.acceptHook({
          backend: "claude", hook_event_name: "SessionStart", session_id: RESTORED_ID, source: "resume", cwd: workspace,
        } as never);
        assert.deepEqual(identities, [RESTORED_ID], "the run's own root resume in the workspace proves the id");
        for (const observation of observations) {
          assert.equal(JSON.stringify(observation).includes(RESTORED_ID), false, "no private id rides a status observation");
          assert.equal("backgroundTasks" in observation || "backgroundShells" in observation, false, "never ownership counts");
        }
        // Activation plus the exact proof is the owner's ordinary launch baseline.
        const latest = observations[observations.length - 1];
        assert.equal(latest?.busy, false);
        assert.equal(latest?.pendingInput, false);
        assert.deepEqual(latest?.activity, ["Ready"]);
        assert.equal(latest?.activeTasks, 0);
        assert.equal(latest?.activeShells, 0);
      } finally {
        observer.dispose();
      }
    }
  });
});

test("without the optional inputs the Claude source proves nothing, and the legacy Codex lane never reports identity", () => {
  withWorkspace((workspace) => {
    const fresh: (string | null)[] = [];
    const claude = createNativeStatusObserver({
      rowId: "claude-row", backend: "claude", emit: () => undefined,
      emitConversationIdentity: (id) => { fresh.push(id); return true; },
    });
    const legacyIdentities: (string | null)[] = [];
    const codex = createNativeStatusObserver({
      rowId: "codex-row", backend: "codex", emit: () => undefined,
      workspace, resumeConversationId: RESTORED_ID,
      emitConversationIdentity: (id) => { legacyIdentities.push(id); return true; },
    });
    try {
      claude.acceptHook({
        backend: "claude", hook_event_name: "SessionStart", session_id: RESTORED_ID, source: "startup", cwd: workspace,
      } as never);
      assert.deepEqual(fresh, [], "with no workspace the source cannot prove a root conversation");
      codex.acceptHook({
        backend: "codex", hook_event_name: "SessionStart", session_id: RESTORED_ID, source: "resume", cwd: workspace,
      } as never);
      assert.deepEqual(legacyIdentities, [], "the legacy Codex hook lane proves no conversation identity");
      assert.deepEqual(codex.support, {
        agent: "supported", input: "unsupported", tasks: "unsupported", shells: "unsupported", activity: "supported",
      }, "the legacy Codex declaration is unchanged");
    } finally {
      claude.dispose();
      codex.dispose();
    }
  });
});

test("an owned-Codex host builds its restoring Codex consumer from the same context without touching identity unproved", () => {
  withWorkspace((workspace) => {
    const identities: (string | null)[] = [];
    const observer = createNativeStatusObserverFactory({ ownedCodexBackend: true })({
      rowId: "codex-row",
      backend: "codex",
      emit: () => ({ accepted: true }) as never,
      workspace,
      resumeConversationId: RESTORED_ID,
      emitConversationIdentity: (id) => { identities.push(id); return true; },
    }) as NativeStatusObserver;
    try {
      observer.acceptHook({
        backend: "codex", hook_event_name: "SessionStart", session_id: RESTORED_ID, source: "resume", cwd: workspace,
      } as never);
      observer.invalidate?.();
      assert.deepEqual(identities, [], "no relay hook or invalidation alone proves or withdraws an unproved restore");
    } finally {
      observer.dispose();
    }
  });
});
