import assert from "node:assert/strict";
import test from "node:test";
import { publishForegroundEscape, routeForegroundEscape } from "../src/foreground-escape";
import { createReviewAbortController } from "../src/activation/review-abort";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { createState } from "../src/state";

test("ownership is session/origin scoped, live-focused, and retired by identity", () => {
  const sessionManager = {};
  const origin = { sessionManager };
  let inputs = 0;
  let focused = true;
  let current = true;
  const owner = { handleInput: () => { inputs++; }, isForeground: () => focused, isCurrent: () => current };
  const retire = publishForegroundEscape(origin, owner);
  try {
    assert.equal(routeForegroundEscape({ sessionManager: {} }, "\x1b"), false);
    assert.equal(routeForegroundEscape({ get sessionManager() { throw Error("stale"); } }, "\x1b"), false);
    assert.equal(routeForegroundEscape({ sessionManager }, "\x1b[27;1:3u"), false);
    assert.equal(routeForegroundEscape({ sessionManager }, "\x1b[27;5u"), false);
    focused = false;
    assert.equal(routeForegroundEscape(origin, "\x1b"), false);
    focused = true;
    current = false;
    assert.equal(routeForegroundEscape(origin, "\x1b"), false);
    current = true;
    assert.equal(routeForegroundEscape({ sessionManager, ui: {} }, "\x1b[27u"), true);
    assert.equal(inputs, 1);
    const retireNew = publishForegroundEscape(origin, { ...owner });
    retire();
    assert.equal(routeForegroundEscape(origin, "\x1b"), true, "old finally cannot retire replacement");
    retireNew();
    assert.equal(routeForegroundEscape(origin, "\x1b"), false);
    const direct = {};
    const retireDirect = publishForegroundEscape(direct, owner);
    assert.equal(routeForegroundEscape({}, "\x1b"), false, "direct fallback requires the explicit same origin");
    assert.equal(routeForegroundEscape(direct, "\x1b"), true);
    retireDirect();
  } finally { retire(); }
});

test("inactive automatic review listeners neither route a popup nor abort", () => {
  let listener!: (input: unknown) => unknown;
  const ctx = { sessionManager: {}, ui: { onTerminalInput(fn: typeof listener) { listener = fn; return () => {}; } } };
  const state = createState();
  state.reviewInProgress = true;
  let routed = 0;
  const retire = publishForegroundEscape(ctx, {
    handleInput: () => { routed++; }, isForeground: () => true, isCurrent: () => true,
  });
  const abort = createReviewAbortController({
    noticeTarget: ctx, state, signal: undefined, isSessionActive: () => false,
    cancellation: createReviewCancellationCoordinator(), settled: Promise.resolve(), describe: () => "review",
  });
  try {
    assert.equal(listener("\x1b"), undefined);
    assert.equal(abort.signal.aborted, false);
    assert.equal(routed, 0);
  } finally { abort.cleanup(); retire(); }
});

test("automatic abort signal stays untouched through synchronous popup done; next press aborts", () => {
  const listeners = new Set<(input: unknown) => { consume?: boolean } | undefined>();
  const ctx = { sessionManager: {}, ui: {
    onTerminalInput(fn: (input: unknown) => { consume?: boolean } | undefined) { listeners.add(fn); return () => listeners.delete(fn); },
  } };
  const state = createState();
  state.reviewInProgress = true;
  const abort = createReviewAbortController({
    noticeTarget: ctx, state, signal: undefined, isSessionActive: () => true,
    cancellation: createReviewCancellationCoordinator(), settled: Promise.resolve(), describe: () => "review",
  });
  let inputs = 0;
  const retire = publishForegroundEscape(ctx, {
    handleInput: () => { inputs++; retire(); }, isForeground: () => true, isCurrent: () => true,
  });
  try {
    for (const listener of listeners) if (listener("\x1b")?.consume) break;
    assert.equal(inputs, 1);
    assert.equal(abort.signal.aborted, false);
    assert.equal(abort.getReason(), undefined);
    for (const listener of listeners) if (listener("\x1b")?.consume) break;
    assert.equal(abort.signal.aborted, true);
    assert.equal(abort.getReason(), "escape");
  } finally { abort.cleanup(); retire(); }
});
