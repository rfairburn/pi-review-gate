/**
 * Pure regression tests with no external I/O (in-memory surfaces only) for the
 * Windows Main acceptance observation helpers (`session-host-mode-witness.ts`).
 * They pin:
 *
 * - the bounded mode-witness ledger cannot lose a later genuine post-parse
 *   class to a data-chunk cap,
 * - the eight-class contraction preserves the exact three `assertBeforeQuitModes`
 *   predicates,
 * - witnesses are only taken after the real surface parses (never from the
 *   pre-parse state), and live restoration is independent of retained ones,
 * - and the PowerShell probe failure and negotiation diagnostics stay bounded,
 *   metadata-only, and free of raw output.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TerminalSurface, type TerminalInputModes } from "../src/session-host/terminal-surface";
import {
  MODE_WITNESS_CLASS_LIMIT,
  ModeWitnessLedger,
  formatModeWitnessDiagnostic,
  modeWitnessKey,
  modeWitnessSignature,
  normalizeWindowsProbeFailure,
  summarizeModeNegotiation,
  type ModeWitnessSignature,
  type WindowsProbeFailureObservation,
} from "./helpers/session-host-mode-witness";

function modes(overrides: Partial<TerminalInputModes> = {}): TerminalInputModes {
  return {
    kittyFlags: 0,
    applicationCursorKeys: false,
    applicationKeypad: false,
    bracketedPaste: false,
    mouseTracking: "none",
    modifyOtherKeys: 0,
    mouseEncoding: "default",
    ...overrides,
  };
}

function allClasses(): ModeWitnessSignature[] {
  const classes: ModeWitnessSignature[] = [];
  for (const bracketedPaste of [false, true]) {
    for (const mouseTrackingSgr of [false, true]) {
      for (const nonBaselineKeyboard of [false, true]) {
        classes.push({ bracketedPaste, mouseTrackingSgr, nonBaselineKeyboard });
      }
    }
  }
  return classes;
}

function observedFor(signature: ModeWitnessSignature): TerminalInputModes {
  return modes({
    bracketedPaste: signature.bracketedPaste,
    mouseTracking: signature.mouseTrackingSgr ? "vt200" : "none",
    mouseEncoding: signature.mouseTrackingSgr ? "sgr" : "default",
    kittyFlags: signature.nonBaselineKeyboard ? 1 : 0,
  });
}

test("bounded mode ledger retains a later genuine class after thousands of mode-irrelevant chunks", () => {
  const ledger = new ModeWitnessLedger();
  const baseline = modes();
  for (let index = 0; index < 5_000; index += 1) {
    ledger.record(baseline);
  }
  assert.equal(ledger.representatives.length, 1, "storage is bounded per truth class, never per data chunk");
  assert.equal(ledger.classCount, 1);
  assert.equal(ledger.record(baseline), false, "a repeated class is not retained again");

  const negotiated = modes({ mouseTracking: "vt200", mouseEncoding: "sgr" });
  assert.equal(ledger.record(negotiated), true,
    "a genuine post-parse class arriving after 2000+ irrelevant chunks is still retained");
  assert.equal(ledger.representatives.length, 2);
  assert.ok(ledger.representatives.some((mode) => mode.mouseTracking !== "none" && mode.mouseEncoding === "sgr"),
    "the late witness satisfies the existing mouse/SGR predicate");
});

test("mode-witness contraction preserves the three exact pre-quit predicates for every class subset", () => {
  const classes = allClasses();
  assert.equal(classes.length, MODE_WITNESS_CLASS_LIMIT);
  assert.equal(new Set(classes.map(modeWitnessKey)).size, MODE_WITNESS_CLASS_LIMIT,
    "the eight truth classes have eight distinct bounded keys");

  const observed = classes.map(observedFor);
  for (let index = 0; index < classes.length; index += 1) {
    assert.deepEqual(modeWitnessSignature(observed[index]!), classes[index],
      "each observation's signature is exactly the three predicate truths");
  }

  for (let mask = 0; mask < (1 << MODE_WITNESS_CLASS_LIMIT); mask += 1) {
    const ledger = new ModeWitnessLedger();
    const included: ModeWitnessSignature[] = [];
    for (let index = 0; index < MODE_WITNESS_CLASS_LIMIT; index += 1) {
      if ((mask & (1 << index)) !== 0) {
        included.push(classes[index]!);
        ledger.record(observed[index]!);
      }
    }
    const representatives = ledger.representatives;
    assert.equal(representatives.length, included.length, "one representative per included class");
    assert.equal(representatives.some((mode) => mode.bracketedPaste),
      included.some((signature) => signature.bracketedPaste), "predicate 1 is preserved exactly");
    assert.equal(representatives.some((mode) => mode.mouseTracking !== "none" && mode.mouseEncoding === "sgr"),
      included.some((signature) => signature.mouseTrackingSgr), "predicate 2 is preserved exactly");
    assert.equal(representatives.some((mode) => mode.kittyFlags > 0 || mode.applicationCursorKeys || mode.applicationKeypad || mode.modifyOtherKeys > 0),
      included.some((signature) => signature.nonBaselineKeyboard), "predicate 3 is preserved exactly");
  }
});

test("mode-witness keyboard class covers every non-baseline keyboard source", () => {
  for (const alternative of [
    modes({ kittyFlags: 1 }),
    modes({ kittyFlags: 7 }),
    modes({ applicationCursorKeys: true }),
    modes({ applicationKeypad: true }),
    modes({ modifyOtherKeys: 1 }),
    modes({ modifyOtherKeys: 2 }),
  ]) {
    assert.equal(modeWitnessSignature(alternative).nonBaselineKeyboard, true,
      "each real non-baseline keyboard source selects the same truth class");
  }
  for (const baseline of [
    modes(),
    modes({ kittyFlags: 0, applicationCursorKeys: false, applicationKeypad: false, modifyOtherKeys: 0 }),
  ]) {
    assert.equal(modeWitnessSignature(baseline).nonBaselineKeyboard, false);
  }
});

test("mode-witness representatives are the exact unmodified first observation of each class", () => {
  const ledger = new ModeWitnessLedger();
  const first = modes({ bracketedPaste: true, kittyFlags: 2 });
  const second = modes({ bracketedPaste: true, kittyFlags: 5, applicationCursorKeys: true });
  assert.equal(ledger.record(first), true);
  assert.equal(ledger.record(second), false, "a later observation of the same class is not retained");
  assert.equal(ledger.representatives.length, 1);
  assert.equal(ledger.representatives[0], first,
    "the retained witness is the genuine observation object, not a copy or synthetic default");
  assert.equal(ledger.representatives[0]!.kittyFlags, 2, "observed fields are never rewritten or normalized");
});

test("no pre-parse or baseline state can produce a positive mode witness", () => {
  const baseline = modes();
  assert.deepEqual(modeWitnessSignature(baseline),
    { bracketedPaste: false, mouseTrackingSgr: false, nonBaselineKeyboard: false },
    "the harness's pre-parse initial sample is the all-false class");

  // A ledger that never recorded a genuine post-parse observation holds no
  // representative at all: the pre-parse sample is deliberately not a witness.
  const ledger = new ModeWitnessLedger();
  assert.equal(ledger.representatives.length, 0);
  const representatives = ledger.representatives;
  assert.equal(representatives.some((mode) => mode.bracketedPaste), false);
  assert.equal(representatives.some((mode) => mode.mouseTracking !== "none" && mode.mouseEncoding === "sgr"), false);
  assert.equal(representatives.some((mode) => mode.kittyFlags > 0 || mode.applicationCursorKeys || mode.applicationKeypad || mode.modifyOtherKeys > 0), false);

  // A preparse-only ledger cannot satisfy any of the three existing predicates.
  ledger.record(baseline);
  assert.equal(ledger.representatives.some((mode) => mode.bracketedPaste), false);
  assert.equal(ledger.representatives.some((mode) => mode.mouseTracking !== "none" && mode.mouseEncoding === "sgr"), false);
  assert.equal(ledger.representatives.some((mode) => mode.kittyFlags > 0 || mode.applicationCursorKeys || mode.applicationKeypad || mode.modifyOtherKeys > 0), false);
});

test("bounded negotiation summary counts only fixed-known sequences", () => {
  const secret = "PROMPT_SECRET_must_not_escape";
  const tail = "\x1b[?1049h" + secret
    + "\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1h\x1b[>4;2m\x1b[>1u\x1b[?7u"
    + "\x1b[?1049l\x1b[?2004l\x1b[?1002l\x1b[?1006l";
  const counts = summarizeModeNegotiation(tail);
  assert.equal(counts.tailBytes, Buffer.byteLength(tail, "utf8"));
  assert.equal(summarizeModeNegotiation("\u{1F600}").tailBytes, 4,
    "tailBytes counts UTF-8 bytes, not UTF-16 code units");
  assert.equal(counts.alternateBufferEnter, 1);
  assert.equal(counts.alternateBufferLeave, 1);
  assert.equal(counts.bracketedPasteSet, 1);
  assert.equal(counts.bracketedPasteReset, 1);
  assert.equal(counts.mouseTrackingSet, 1);
  assert.equal(counts.mouseTrackingReset, 1);
  assert.equal(counts.mouseSgrEncodingSet, 1);
  assert.equal(counts.mouseSgrEncodingReset, 1);
  assert.equal(counts.mouseSgrPixelsEncodingSet, 0);
  assert.equal(counts.mouseSgrPixelsEncodingReset, 0);
  assert.equal(counts.applicationCursorKeysSet, 1);
  assert.equal(counts.applicationCursorKeysReset, 0);
  assert.equal(counts.applicationKeypadSet, 0);
  assert.equal(counts.modifyOtherKeysSet, 1);
  assert.equal(counts.modifyOtherKeysReset, 0);
  assert.equal(counts.kittyKeyboardPush, 1, "the CSI > ... u push request is counted");
  assert.equal(counts.kittyKeyboardSet, 0);
  assert.equal(counts.kittyKeyboardPop, 0);
});

test("negotiation summary keeps the 1006 encoding and Kitty pop/reset requests distinct", () => {
  const tail = "\x1b[?1002h\x1b[?1016h\x1b[<u\x1b[=0u\x1b[=7;3u";
  const counts = summarizeModeNegotiation(tail);
  assert.equal(counts.mouseTrackingSet, 1);
  assert.equal(counts.mouseSgrEncodingSet, 0,
    "1016 is SGR-pixels, not the 1006 SGR encoding the existing predicate checks");
  assert.equal(counts.mouseSgrPixelsEncodingSet, 1);
  assert.equal(counts.kittyKeyboardPush, 0);
  assert.equal(counts.kittyKeyboardSet, 2, "both the zero reset and the remove request are counted");
  assert.equal(counts.kittyKeyboardPop, 1);
});

test("negotiation summary recognizes combined DECSET/DECRST lists for known modes", () => {
  const tail = "\x1b[?1003;1006h\x1b[?1003;1006l";
  const counts = summarizeModeNegotiation(tail);
  assert.equal(counts.mouseTrackingSet, 1, "the combined enable list requests tracking mode 1003");
  assert.equal(counts.mouseSgrEncodingSet, 1, "the combined enable list requests the 1006 SGR encoding");
  assert.equal(counts.mouseTrackingReset, 1, "the combined disable list resets tracking mode 1003");
  assert.equal(counts.mouseSgrEncodingReset, 1, "the combined disable list resets the 1006 SGR encoding");
  assert.equal(counts.alternateBufferEnter, 0);
  assert.equal(counts.bracketedPasteSet, 0);
  assert.equal(counts.applicationCursorKeysSet, 0);
});

test("negotiation summary counts each known mode in a mixed list once and never counts unknown modes", () => {
  const tail = "\x1b[?7;25;1000;1002;1003;1003;1016h\x1b[?1;66l";
  const counts = summarizeModeNegotiation(tail);
  assert.equal(counts.mouseTrackingSet, 3,
    "each distinct known tracking mode is counted once, including a repeated parameter");
  assert.equal(counts.mouseSgrPixelsEncodingSet, 1);
  assert.equal(counts.applicationCursorKeysReset, 1);
  assert.equal(counts.applicationKeypadReset, 1);
  assert.equal(counts.mouseSgrEncodingSet, 0, "1006 is absent from the list");
  assert.equal(counts.alternateBufferEnter, 0);
  assert.equal(counts.bracketedPasteSet, 0);
});

test("negotiation summary treats leading-zero DEC parameters numerically", () => {
  const counts = summarizeModeNegotiation("\x1b[?01;02004h\x1b[?01006l");
  assert.equal(counts.applicationCursorKeysSet, 1);
  assert.equal(counts.bracketedPasteSet, 1);
  assert.equal(counts.mouseSgrEncodingReset, 1);
});

test("negotiation summary rejects partial, truncated, and malformed DEC lists", () => {
  const tails = [
    "\x1b[?1003;1006", // truncated: no final byte
    "\x1b[?1003;", // trailing separator
    "\x1b[?;1006h", // empty first parameter
    "\x1b[?1003;h", // empty second parameter
    "\x1b[?100 6h", // a space is not a decimal parameter byte
    "\x1b[?1003u", // wrong final byte
    "\x1b[?10034h", // 10034 is a different mode, not a substring of 1003
    "\x1b[?10030h", // 10030 is a different mode, not a substring of 1003
  ];
  for (const tail of tails) {
    const counts = summarizeModeNegotiation(tail);
    assert.equal(counts.mouseTrackingSet, 0, `no false positive from ${JSON.stringify(tail)}`);
    assert.equal(counts.mouseSgrEncodingSet, 0, `no false positive from ${JSON.stringify(tail)}`);
    assert.equal(counts.applicationCursorKeysSet, 0, `no false positive from ${JSON.stringify(tail)}`);
    assert.equal(counts.alternateBufferEnter, 0, `no false positive from ${JSON.stringify(tail)}`);
    assert.equal(counts.bracketedPasteSet, 0, `no false positive from ${JSON.stringify(tail)}`);
    assert.equal(counts.applicationKeypadSet, 0, `no false positive from ${JSON.stringify(tail)}`);
  }
});

test("mode-witness diagnostic recognizes combined tracking/SGR lists without leaking the tail", () => {
  const secret = "COMBINED_LIST_SECRET_prompt_text";
  const line = formatModeWitnessDiagnostic({
    outputTail: `\x1b[?1003;1006h${secret}`,
    representatives: [modes()],
    deviceAttributesReplies: 0,
    kittyQueryReplies: 0,
    alternateBufferEntered: false,
    alternateBufferLeft: false,
  });
  assert.ok(line.includes("trackSet=1") && line.includes("sgr1006Set=1"),
    "the combined list is counted for both known modes");
  assert.ok(line.includes("sequencePresence{bracketedPaste=false trackingSgr=true keyboard=false}"),
    "a combined list yields the same sequence-presence hint as separate sequences");
  assert.equal(line.includes(secret), false, "no raw tail or user string is emitted");
  assert.ok(line.length < 1_024, "the diagnostic line stays bounded");
});

test("mode-witness diagnostic reports bounded tail sequence presence without asserting a cause", () => {
  const secret = "NATIVE_USER_SECRET_prompt_text";
  const lost = formatModeWitnessDiagnostic({
    outputTail: `\x1b[?2004h\x1b[?1002h\x1b[?1006h${secret}`,
    representatives: [modes()],
    deviceAttributesReplies: 2,
    kittyQueryReplies: 1,
    alternateBufferEntered: true,
    alternateBufferLeft: false,
  });
  assert.ok(lost.includes("classes=1/8"), "the retained class count is disclosed");
  assert.ok(lost.includes("signatures=000"), "only bounded signature keys are disclosed");
  assert.ok(lost.includes("sequencePresence{bracketedPaste=true trackingSgr=true keyboard=false}"),
    "sequence presence is reported independently of the retained mode class");
  assert.ok(lost.includes("daReplies=2"));
  assert.ok(lost.includes("kittyReplies=1"));

  const missing = formatModeWitnessDiagnostic({
    outputTail: `no known mode sequence here ${secret}`,
    representatives: [modes()],
    deviceAttributesReplies: -3,
    kittyQueryReplies: Number.NaN,
    alternateBufferEntered: false,
    alternateBufferLeft: false,
  });
  assert.ok(missing.includes("sequencePresence{bracketedPaste=false trackingSgr=false keyboard=false}"),
    "absence is scoped to this bounded tail, not the full negotiation history");
  assert.ok(missing.includes("daReplies=-1") && missing.includes("kittyReplies=-1"),
    "non-finite counts normalize to the bounded -1 sentinel");

  for (const line of [lost, missing]) {
    assert.equal(line.includes(secret), false, "no raw tail, prompt, or user string is emitted");
    assert.ok(line.length < 1_024, "the diagnostic line stays bounded");
  }

  const pixelsOnly = formatModeWitnessDiagnostic({
    outputTail: "\x1b[?1002h\x1b[?1016h",
    representatives: [modes()],
    deviceAttributesReplies: 0,
    kittyQueryReplies: 0,
    alternateBufferEntered: true,
    alternateBufferLeft: false,
  });
  assert.ok(pixelsOnly.includes("sgr1016Set=1"));
  assert.ok(pixelsOnly.includes("sequencePresence{bracketedPaste=false trackingSgr=false keyboard=false}"),
    "1016 SGR-pixels never satisfies the 1006 SGR tracking hint");

  const kittyReset = formatModeWitnessDiagnostic({
    outputTail: "\x1b[<u\x1b[=0u\x1b[=7;3u",
    representatives: [modes()],
    deviceAttributesReplies: 0,
    kittyQueryReplies: 0,
    alternateBufferEntered: true,
    alternateBufferLeft: false,
  });
  assert.ok(kittyReset.includes("kittyPop=1") && kittyReset.includes("kittySet=2"));
  assert.ok(kittyReset.includes("sequencePresence{bracketedPaste=false trackingSgr=false keyboard=false}"),
    "a Kitty pop, zero reset, or remove request is not keyboard negotiation");
});

test("the outer surface records witnesses only after parsing, and live restoration stays independent of them", async () => {
  const ledger = new ModeWitnessLedger();
  const surface = new TerminalSurface(80, 24, {
    onChange: () => {
      ledger.record(surface.inputModes());
    },
  });
  try {
    const baseline = surface.inputModes();
    surface.write("\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1h");
    assert.equal(ledger.representatives.length, 0,
      "no witness may be taken from the pre-parse state immediately after write()");
    await surface.flush();
    assert.equal(ledger.representatives.length, 1, "the genuine post-parse negotiation is recorded after parsing");
    assert.deepEqual(ledger.representatives[0], {
      ...baseline,
      bracketedPaste: true,
      mouseTracking: "drag",
      mouseEncoding: "sgr",
      applicationCursorKeys: true,
    }, "the recorded witness is the real parsed mode state, not a pre-parse or synthetic one");

    // Reset every negotiated mode and parse. The live surface must return to
    // the exact baseline while the retained historical witness is untouched.
    surface.write("\x1b[?2004l\x1b[?1002l\x1b[?1006l\x1b[?1l");
    await surface.flush();
    assert.deepEqual(surface.inputModes(), baseline,
      "live restoration is read from the surface itself, not inferred from retained witnesses");
    assert.ok(ledger.representatives.some((mode) => mode.bracketedPaste),
      "resetting the terminal does not erase the genuine historical negotiation witness");
  } finally {
    surface.dispose();
  }
});

test("PowerShell probe failure normalization discloses bounded numeric and boolean state", () => {
  assert.equal(
    normalizeWindowsProbeFailure({
      hadSpawnError: true,
      errorCode: "ETIMEDOUT",
      status: null,
      signal: "SIGTERM",
      stdoutVersionMatched: false,
      elapsedMs: 10_226,
    }),
    "elapsedMs=10226 hadSpawnError=true errno=ETIMEDOUT status=null signal=SIGTERM stdoutVersionMatched=false",
    "an allowlisted errno token and signal are disclosed without asserting a cause",
  );
  assert.equal(
    normalizeWindowsProbeFailure({
      hadSpawnError: false,
      errorCode: undefined,
      status: 1,
      signal: null,
      stdoutVersionMatched: true,
      elapsedMs: 12,
    }),
    "elapsedMs=12 hadSpawnError=false errno=other status=1 signal=null stdoutVersionMatched=true",
    "an integer status and null signal stay exact and bounded",
  );
});

test("PowerShell probe failure normalization never leaks raw or unlisted state", () => {
  const hostile = {
    hadSpawnError: true,
    errorCode: "ENOTALLOWLISTED",
    status: 3.5,
    signal: "SIGWHATEVER",
    stdoutVersionMatched: false,
    elapsedMs: -5,
    message: "raw error message",
    stdout: "raw stdout",
    stderr: "raw stderr",
    args: ["secret-arg"],
    env: { SECRET: "value" },
  } as unknown as WindowsProbeFailureObservation;
  const line = normalizeWindowsProbeFailure(hostile);
  assert.equal(line,
    "elapsedMs=-1 hadSpawnError=true errno=other status=null signal=other stdoutVersionMatched=false");
  for (const raw of ["raw error message", "raw stdout", "raw stderr", "secret-arg", "SECRET", "value"]) {
    assert.equal(line.includes(raw), false, `the diagnostic must not contain ${raw}`);
  }
});
