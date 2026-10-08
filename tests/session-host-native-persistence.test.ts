import assert from "node:assert/strict";
import test from "node:test";
import { NativePersistenceTracker, probeNativeSessionFile, readNativePersistence, parseNativePersistenceReceipt } from "../src/session-host/native-persistence";

const A = "a11a";
const B = "b22b";

test("pure persistence receipt never equates missing metadata with a never-saved conversation", () => {
  const tracker = new NativePersistenceTracker();
  assert.equal(tracker.snapshot(), undefined);
  assert.deepEqual(tracker.observe(A, "unknown"), { sessionId: A, persistence: "unknown" });
  assert.deepEqual(tracker.observe(A, "unsaved"), { sessionId: A, persistence: "unsaved" });
});

test("pure saved receipt survives missing/unreadable file observations and reload", () => {
  const tracker = new NativePersistenceTracker();
  assert.deepEqual(tracker.observe(A, "saved"), { sessionId: A, persistence: "saved" });
  assert.equal(tracker.observe(A, "unsaved")!.persistence, "saved");
  assert.equal(tracker.observe(A, "unknown")!.persistence, "saved");
  const reloaded = new NativePersistenceTracker(tracker.snapshot());
  assert.equal(reloaded.observe(A, "unsaved")!.persistence, "saved");
});

test("pure native rebind does not reuse the preceding conversation's saved receipt", () => {
  const tracker = new NativePersistenceTracker({ sessionId: A, persistence: "saved" });
  assert.deepEqual(tracker.observe(B, "unsaved"), { sessionId: B, persistence: "unsaved" });
  assert.equal(tracker.observe(B, "unknown")!.persistence, "unknown");
});

test("pure receipt copies and invalid identities cannot mutate the authoritative binding", () => {
  const tracker = new NativePersistenceTracker();
  const receipt = tracker.observe(A, "saved")!;
  (receipt as { persistence: string }).persistence = "unsaved";
  assert.equal(tracker.snapshot()!.persistence, "saved");
  assert.equal(tracker.observe("path/not-a-session", "unsaved"), undefined);
  assert.equal(tracker.snapshot()!.sessionId, A);
});

test("pure public persistence reader distinguishes in-memory from unavailable APIs and preserves receiver", () => {
  const manager = {
    getSessionId() { assert.equal(this, manager); return A; },
    getSessionFile() { assert.equal(this, manager); return undefined; },
  };
  assert.equal(readNativePersistence({ sessionManager: manager }, A, () => { throw Error("must not probe in-memory"); }), "unsaved");
  assert.equal(readNativePersistence({ sessionManager: { getSessionId: () => A } }, A), "unknown");
  assert.equal(readNativePersistence({ sessionManager: { getSessionId: () => A, getSessionFile() { throw Error("unavailable"); } } }, A), "unknown");
});

test("pure public persistence reader rejects a changed binding during file observation", () => {
  let id = A;
  const manager = { getSessionId: () => id, getSessionFile: () => "/exact/planned/file.jsonl" };
  assert.equal(readNativePersistence({ sessionManager: manager }, A, (file) => {
    assert.equal(file, "/exact/planned/file.jsonl"); id = B; return "unsaved";
  }), "unknown");
});

test("pure sticky persistence decoding rejects malformed receipts", () => {
  for (const value of [null, {}, { sessionId: "unsafe/path", persistence: "saved" }, { sessionId: A, persistence: false }]) {
    assert.equal(parseNativePersistenceReceipt(value), undefined);
  }
  assert.deepEqual(parseNativePersistenceReceipt({ sessionId: A, persistence: "saved" }), { sessionId: A, persistence: "saved" });
});

test("invalid planned-file inputs are unknown without any filesystem inspection", () => {
  for (const file of [undefined, null, "", "relative.jsonl", "x\n.jsonl", "a".repeat(2049)]) {
    assert.equal(probeNativeSessionFile(file), "unknown");
  }
});
