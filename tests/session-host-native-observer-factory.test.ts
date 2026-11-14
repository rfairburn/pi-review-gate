import assert from "node:assert/strict";
import test from "node:test";
import { createNativeStatusObserver } from "../src/session-host/native-observer-factory";
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
