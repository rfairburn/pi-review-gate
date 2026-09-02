import assert from "node:assert/strict";
import test from "node:test";
import { extractInputSource, extractInputText, extractSignal, isEscapeTerminalInput, onTerminalInput } from "../src/pi";
import { createState, rememberUserRequest } from "../src/state";

test("extractInputSource reads pi input event source", () => {
  assert.equal(
    extractInputSource([{ type: "input", text: "fix it", source: "extension" }]),
    "extension",
  );
});

test("extractSignal reads pi event context signal", () => {
  const controller = new AbortController();
  assert.equal(extractSignal([{ cwd: process.cwd(), signal: controller.signal }]), controller.signal);
  assert.equal(extractSignal([{ ctx: { signal: controller.signal } }]), controller.signal);
});

test("isEscapeTerminalInput recognizes supported terminal event shapes", () => {
  assert.equal(isEscapeTerminalInput("\x1b"), true);
  assert.equal(isEscapeTerminalInput("Escape"), true);
  assert.equal(isEscapeTerminalInput({ name: "escape" }), true);
  assert.equal(isEscapeTerminalInput({ key: "Escape" }), true);
  assert.equal(isEscapeTerminalInput({ key: { name: "escape" } }), true);
  assert.equal(isEscapeTerminalInput({ sequence: "\x1b" }), true);
  assert.equal(isEscapeTerminalInput("enter"), false);
});

test("isEscapeTerminalInput recognizes real Pi raw Escape sequences and rejects release/modified forms", () => {
  // Legacy terminals: bare ESC.
  assert.equal(isEscapeTerminalInput("\x1b"), true);
  // Kitty keyboard protocol CSI-u: unmodified Escape press (modifier omitted or 1).
  assert.equal(isEscapeTerminalInput("\x1b[27u"), true);
  assert.equal(isEscapeTerminalInput("\x1b[27;1u"), true);
  assert.equal(isEscapeTerminalInput("\x1b[27;1:1u"), true);
  // Explicit press-event and repeat forms must still cancel.
  assert.equal(isEscapeTerminalInput("\x1b[27;1:2u"), true);
  // Lock-state bits are not user modifiers (Caps Lock, Num Lock, or both).
  assert.equal(isEscapeTerminalInput("\x1b[27;65u"), true);
  assert.equal(isEscapeTerminalInput("\x1b[27;129u"), true);
  assert.equal(isEscapeTerminalInput("\x1b[27;193u"), true);
  // Alternate-key sub-parameters (shifted/base layout keys).
  assert.equal(isEscapeTerminalInput("\x1b[27:27;1u"), true);
  assert.equal(isEscapeTerminalInput("\x1b[27:27:27;1u"), true);
  assert.equal(isEscapeTerminalInput("\x1b[27::27;1u"), true);
  // xterm modifyOtherKeys: unmodified Escape.
  assert.equal(isEscapeTerminalInput("\x1b[27;1;27~"), true);

  // Key-release events must never cancel.
  assert.equal(isEscapeTerminalInput("\x1b[27;1:3u"), false);
  // Modified Escape (shift/alt/ctrl/super) must never cancel.
  assert.equal(isEscapeTerminalInput("\x1b[27;2u"), false);
  assert.equal(isEscapeTerminalInput("\x1b[27;3u"), false);
  assert.equal(isEscapeTerminalInput("\x1b[27;5u"), false);
  assert.equal(isEscapeTerminalInput("\x1b[27;66u"), false);
  assert.equal(isEscapeTerminalInput("\x1b[27;2;27~"), false);
  assert.equal(isEscapeTerminalInput("\x1b[27;5;27~"), false);
  // Other CSI-u keys are not Escape.
  assert.equal(isEscapeTerminalInput("\x1b[13u"), false);
  assert.equal(isEscapeTerminalInput("\x1b[13;1u"), false);
  // Malformed / unrelated sequences are ignored.
  assert.equal(isEscapeTerminalInput("\x1b[A"), false);
  assert.equal(isEscapeTerminalInput("\x1b[27~"), false);
  assert.equal(isEscapeTerminalInput("abc"), false);
});

test("onTerminalInput unwraps dispose-style subscriptions", () => {
  const handler = () => undefined;
  let disposed = 0;
  const target = {
    onTerminalInput: () => ({ dispose: () => { disposed += 1; } }),
  };
  const dispose = onTerminalInput(target, handler);
  dispose?.();
  assert.equal(disposed, 1);

  let unsubscribed = 0;
  const unsubscribeTarget = {
    onTerminalInput: () => ({ unsubscribe: () => { unsubscribed += 1; } }),
  };
  const unsubscribe = onTerminalInput(unsubscribeTarget, handler);
  unsubscribe?.();
  assert.equal(unsubscribed, 1);
});

test("onTerminalInput survives a throwing registration target and reports unavailable when none remain", () => {
  const handler = () => undefined;
  const throwingUi = {
    onTerminalInput: () => {
      throw new Error("terminal input unavailable");
    },
  };

  // ui.onTerminalInput throws; the pi-level fallback target must still register.
  let registered = 0;
  const withFallback = {
    ui: throwingUi,
    onTerminalInput: () => { registered += 1; return () => undefined; },
  };
  assert.equal(typeof onTerminalInput(withFallback, handler), "function");
  assert.equal(registered, 1);

  // No eligible target left: return undefined (interception unavailable) instead of throwing.
  assert.equal(onTerminalInput({ ui: throwingUi }, handler), undefined);
});

test("extension follow-up input should not reset correction cycle state", () => {
  const state = createState();
  rememberUserRequest(state, "original user request");
  state.reviewWindow!.correctionCycles = 1;

  const event = {
    type: "input",
    text: "Review found blocking issues in your last changes.",
    source: "extension",
  };

  if (extractInputSource([event]) !== "extension") {
    rememberUserRequest(state, extractInputText([event]));
  }

  assert.equal(state.reviewWindow!.requestHistory.at(-1)?.text, "original user request");
  assert.equal(state.reviewWindow!.correctionCycles, 1);
});
