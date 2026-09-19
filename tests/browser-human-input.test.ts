import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createHumanInputInitScript,
  HUMAN_INPUT_KINDS,
  HUMAN_INPUT_SIGNAL_MIN_GAP_MS,
  humanInputToken,
  HumanInputVerifier,
} from "../src/web/browser-human-input";

const SECRET = "a".repeat(64);
const OTHER_SECRET = "b".repeat(64);

interface Sandbox {
  listeners: Map<string, Array<(event: { type: string; isTrusted?: boolean }) => void>>;
  sent: string[];
  now: number;
  script: string;
  dispatch(kind: string, trusted: boolean): void;
  advance(ms: number): void;
}

/** Evaluate the generated detector script exactly as a browser-owned isolated
 * world would: with its own globals (`window`, `console`, `Date`, `Math`) and
 * no channel to anything outside its realm. */
function sandbox(): Sandbox {
  const listeners = new Map<string, Array<(event: { type: string; isTrusted?: boolean }) => void>>();
  const sent: string[] = [];
  let now = 1_000;
  const window: Record<string, unknown> = {
    addEventListener: (kind: string, handler: (event: { type: string; isTrusted?: boolean }) => void, capture: unknown) => {
      assert.equal(capture, true, "listener must use the capture phase");
      listeners.set(kind, [...(listeners.get(kind) ?? []), handler]);
    },
  };
  const script = createHumanInputInitScript(SECRET);
  runInNewContext(script, {
    window,
    console: { debug: (token: string) => sent.push(token) },
    Math,
    Date: { now: () => now },
  });
  return {
    listeners, sent, now, script,
    dispatch(kind: string, trusted: boolean) {
      for (const handler of listeners.get(kind) ?? []) handler({ type: kind, isTrusted: trusted });
    },
    advance(ms: number) { now += ms; },
  };
}

test("detector registers capture listeners only for non-fabricable trusted input kinds", () => {
  const box = sandbox();
  assert.deepEqual([...box.listeners.keys()].sort(), [...HUMAN_INPUT_KINDS].sort());
  // Page scripts can fabricate trusted `click` events (element.click()); it is
  // deliberately absent from the monitored set.
  assert.equal(box.listeners.has("click"), false);
  assert.equal(box.listeners.has("scroll"), false);
  // The detector is installed in a dedicated isolated world, not the main world.
  assert.match(box.script, new RegExp(`"use strict"`));
});

test("trusted human input emits exactly one verifier-accepted token per event", () => {
  const box = sandbox();
  const verifier = new HumanInputVerifier(SECRET);
  box.dispatch("pointerdown", true);
  box.advance(HUMAN_INPUT_SIGNAL_MIN_GAP_MS + 1);
  box.dispatch("keydown", true);
  box.advance(HUMAN_INPUT_SIGNAL_MIN_GAP_MS + 1);
  box.dispatch("wheel", true);
  assert.equal(box.sent.length, 3);
  // Each token is accepted exactly once; the detector-side pure-JS HMAC must
  // agree with node's createHmac.
  assert.equal(verifier.accept(box.sent[0]), true);
  assert.equal(verifier.accept(box.sent[1]), true);
  assert.equal(verifier.accept(box.sent[2]), true);
});

test("untrusted dispatchEvent, fabricated trusted clicks, and programmatic scrolling never signal", () => {
  const box = sandbox();
  const verifier = new HumanInputVerifier(SECRET);
  // What page script can do: dispatchEvent (untrusted), element.click()
  // (trusted `click`, unmonitored), scrollTo/scrollBy (unmonitored `scroll`).
  box.dispatch("pointerdown", false);
  box.dispatch("mousedown", false);
  box.dispatch("keydown", false);
  box.dispatch("wheel", false);
  box.dispatch("click", true);
  box.dispatch("scroll", true);
  assert.equal(box.sent.length, 0);
  // And the same inputs cannot renew through the verifier either.
  assert.equal(verifier.accept("garbage"), false);
  assert.equal(verifier.accept(null), false);
  assert.equal(verifier.accept(42), false);
});

test("signals are rate-limited per document without dropping renewal coverage", () => {
  const box = sandbox();
  box.dispatch("keydown", true);
  assert.equal(box.sent.length, 1);
  box.advance(10);
  box.dispatch("keydown", true);
  box.dispatch("pointerdown", true);
  assert.equal(box.sent.length, 1, "trusted input inside the signal gap does not re-signal");
  box.advance(HUMAN_INPUT_SIGNAL_MIN_GAP_MS);
  box.dispatch("pointerdown", true);
  assert.equal(box.sent.length, 2, "the next trusted input after the gap signals again");
});

test("the detector secret stays realm-bound: IIFE closure, never a page-reachable global", () => {
  const box = sandbox();
  assert.equal(box.script.startsWith("(() => {"), true, "detector script is IIFE-wrapped");
  assert.doesNotMatch(box.script, /window\.(?:SECRET|secret)\s*=/);
  assert.doesNotMatch(box.script, /window\[SECRET\s*\]\s*=/);
  // The token leaves the realm only as a console payload, never as a property.
  assert.match(box.script, /var SECRET = "[0-9a-f]{64}";/);
  assert.doesNotMatch(box.script, /window\[/);
});

test("verifier rejects forged, replayed, cross-secret, and malformed tokens", () => {
  const verifier = new HumanInputVerifier(SECRET);
  const otherVerifier = new HumanInputVerifier(OTHER_SECRET);
  const token = humanInputToken(SECRET, "0123456789abcdef", "keydown", 1);
  assert.equal(verifier.accept(token), true);
  assert.equal(verifier.accept(token), false, "replay of an already-used counter is rejected");
  assert.equal(verifier.accept(humanInputToken(SECRET, "0123456789abcdef", "keydown", 1)), false, "re-minted identical token is still replay");
  assert.equal(verifier.accept(humanInputToken(SECRET, "0123456789abcdef", "keydown", 0)), false, "counter must increase");
  assert.equal(verifier.accept(humanInputToken(SECRET, "0123456789abcdef", "keydown", 5)), true);
  assert.equal(verifier.accept(humanInputToken(SECRET, "0123456789abcdef", "keydown", 5)), false);
  assert.equal(verifier.accept(humanInputToken(OTHER_SECRET, "0123456789abcdef", "keydown", 6)), false, "wrong-secret digest rejected");
  assert.equal(otherVerifier.accept(humanInputToken(SECRET, "0123456789abcdef", "keydown", 7)), false);
  assert.equal(verifier.accept(humanInputToken(SECRET, "0123456789abcdef", "click", 8)), false, "unmonitored kinds rejected");
  assert.equal(verifier.accept(humanInputToken(SECRET, "short", "keydown", 9)), false, "malformed document id rejected");
  assert.equal(verifier.accept(`0123456789abcdef.keydown.10.${"0".repeat(64)}`), false, "zero digest rejected");
  assert.equal(verifier.accept(`0123456789abcdef.keydown.11.${"z".repeat(64)}`), false, "non-hex digest rejected");
  const overflow = Number.MAX_SAFE_INTEGER + 1;
  assert.equal(verifier.accept(`${"0123456789abcdef"}.keydown.${overflow}.` + createHmac("sha256", Buffer.from(SECRET)).update(`0123456789abcdef|keydown|${overflow}`).digest("hex")), false, "unsafe-integer counters rejected by token shape");
});

test("the verifier's per-document counter registry stays bounded", () => {
  const verifier = new HumanInputVerifier(SECRET);
  let accepted = 0;
  for (let document = 0; document < 80; document += 1) {
    const id = document.toString(16).padStart(16, "0");
    if (verifier.accept(humanInputToken(SECRET, id, "pointerdown", 1))) accepted += 1;
  }
  assert.equal(accepted, 80);
  assert.ok(verifier.trackedDocuments <= 64, `bounded registry, got ${verifier.trackedDocuments}`);
});

test("constructor validates its inputs", () => {
  assert.throws(() => new HumanInputVerifier("short"), /64 hex/);
  assert.throws(() => createHumanInputInitScript("zz"), /64 hex/);
});