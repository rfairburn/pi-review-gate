/*
 * Test cases derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { describe, it } from "node:test";
import { expect } from "./helpers/expect";
import {
  MAX_BUFFER_CHARS,
  MAX_PENDING_LINE_CHARS,
  MAX_STORED_LINE_CHARS,
  MAX_WAKE_PATTERNS,
  MAX_WAKE_PAYLOAD_CHARS,
  PendingLineBuffer,
  TRUNCATION_MARKER,
  LineBuffer,
  MIN_WAKE_INTERVAL_MS,
  compileMatcher,
  compileMatchers,
  evaluateExit,
  evaluateMatch,
  evaluateSilence,
  findMatch,
  formatElapsed,
  formatWakePayload,
  laneDelivery,
  normalizeRules,
  parseDuration,
  truncateText,
  wrapWithParentWatchdog,
  type JobWakeState,
} from "../src/background-shell/jobs";

const freshState = (over: Partial<JobWakeState> = {}): JobWakeState => ({
  matchCount: 0,
  lastWakeAt: 0,
  stallNotified: false,
  ...over,
});

describe("parseDuration", () => {
  it("parses the suffixed forms", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });
  it("treats a bare number as seconds", () => {
    expect(parseDuration("30")).toBe(30_000);
    expect(parseDuration(30)).toBe(30_000);
  });
  // A typo must disable the rule, not silently mean "0ms" (= wake constantly).
  it("returns null for nonsense rather than zero", () => {
    for (const bad of ["", "soon", "-5s", "0", {}, null, undefined]) {
      expect(parseDuration(bad as any), String(bad)).toBeNull();
    }
  });
});

describe("normalizeRules", () => {
  it("defaults to waking on exit only", () => {
    expect(normalizeRules(undefined)).toEqual({ exit: true, match: [] });
  });
  it("accepts a single string or an array for match", () => {
    expect(normalizeRules({ match: "Traceback" }).match).toEqual(["Traceback"]);
    expect(normalizeRules({ match: ["a", "b"] }).match).toEqual(["a", "b"]);
  });
  it("accepts both snake_case and camelCase for every_n_matches", () => {
    expect(normalizeRules({ every_n_matches: 10 }).everyNMatches).toBe(10);
    expect(normalizeRules({ everyNMatches: 4 }).everyNMatches).toBe(4);
  });
  it("ignores a malformed field instead of failing the whole call", () => {
    const r = normalizeRules({ match: [1, "ok", null], silence: "later", every_n_matches: 1 });
    expect(r.match).toEqual(["ok"]);
    expect(r.silenceMs).toBeUndefined();
    expect(r.everyNMatches).toBeUndefined(); // N=1 is not a throttle
  });
  it("honours exit:false", () => {
    expect(normalizeRules({ exit: false }).exit).toBe(false);
  });
});

describe("compileMatcher (RE2-backed, finding 4)", () => {
  it("treats a valid pattern as a case-insensitive unicode regex", () => {
    expect(compileMatcher("val_loss=[0-9.]+")("  val_loss=0.31")).toBe(true);
    expect(compileMatcher("^Epoch")("Epoch 3/50")).toBe(true);
    // 'i' + 'u' flags: case-insensitive matching over unicode text.
    expect(compileMatcher("héllo")("say HÉLLO there")).toBe(true);
  });
  // Models write prose far more often than they write anchors.
  it("degrades an invalid regex to a literal substring rather than throwing", () => {
    const m = compileMatcher("CUDA out of memory (");
    expect(() => m("x")).not.toThrow();
    expect(m("RuntimeError: CUDA out of memory (tried to allocate)")).toBe(true);
  });
  it("degrades RE2-unsupported constructs (lookahead) to the literal fallback", () => {
    // RE2 has no lookahead, so construction throws and the pattern is matched
    // as a literal substring — it must find the pattern text itself, and must
    // NOT behave like a regex with lookahead semantics.
    const m = compileMatcher("foo(?=bar)");
    expect(() => m("x")).not.toThrow();
    expect(m("use foo(?=bar) here")).toBe(true); // literal text is found
    expect(m("foobar")).toBe(false); // no lookahead semantics
  });

  // The heart of finding 4: a catastrophic-backtracking pattern must be
  // evaluated by the linear-time engine, NOT V8's backtracking RegExp — V8
  // would grind on this input for far longer than any test deadline. The
  // bound is generous so the assertion stays deterministic; RE2 finishes in
  // microseconds, the literal fallback in milliseconds, V8 in hours.
  it("evaluates a catastrophic pattern in bounded time", () => {
    const m = compileMatcher("(a+)+$");
    const line = "a".repeat(200_000) + "!";
    const t0 = Date.now();
    expect(m(line)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("keeps matching linear in the candidate length via the line cap", () => {
    const m = compileMatchers(["needle"]).match;
    // A line far beyond MAX_MATCH_LINE_CHARS is only ever scanned up to the cap.
    const huge = "x".repeat(5_000_000) + "needle";
    const t0 = Date.now();
    expect(m(huge)).toBeNull(); // 'needle' sits past the candidate cap
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("compileMatchers (compiled once per job)", () => {
  it("returns the first matching pattern", () => {
    const m = compileMatchers(["Traceback", "val_loss="]);
    expect(m.match("  Traceback (most recent call last)")).toBe("Traceback");
    expect(m.match("epoch 2 val_loss=0.4")).toBe("val_loss=");
    expect(m.match("all quiet")).toBeNull();
  });
  it("caps pattern count and length defensively", () => {
    const m = compileMatchers(Array.from({ length: 50 }, (_, i) => `p${i}`));
    expect(m.patterns.length).toBe(MAX_WAKE_PATTERNS);
    const long = compileMatchers(["a".repeat(10_000)]);
    expect(long.patterns[0].length).toBeLessThanOrEqual(512);
  });
  it("caps the candidate line before matching", () => {
    // 'needle' placed just past the cap must not match; the matcher only
    // ever sees the first MAX_MATCH_LINE_CHARS characters.
    const line = "x".repeat(8_192) + "needle";
    expect(compileMatchers(["needle"]).match(line)).toBeNull();
    expect(compileMatchers(["needle"]).match("x" + "needle")).toBe("needle");
  });
  it("findMatch honours pre-compiled matchers", () => {
    const rules = { exit: true, match: ["Traceback"] };
    const m = compileMatchers(rules.match);
    expect(findMatch("Traceback here", rules, m)).toBe("Traceback");
    expect(findMatch("quiet", rules, m)).toBeNull();
  });

  it("normalizeRules caps the pattern list", () => {
    const many = normalizeRules({ match: Array.from({ length: 40 }, (_, i) => `p${i}`) });
    expect(many.match.length).toBe(MAX_WAKE_PATTERNS);
    const long = normalizeRules({ match: ["a".repeat(9_999)] });
    expect(long.match[0].length).toBeLessThanOrEqual(512);
  });
});

describe("truncateText", () => {
  it("leaves short text alone", () => {
    expect(truncateText("short", 100)).toBe("short");
  });
  it("cuts with a visible marker", () => {
    const out = truncateText("a".repeat(500), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
  it("degenerates safely at tiny caps", () => {
    const out = truncateText("abcdef", 4);
    expect(out.length).toBe(4);
  });
});

describe("LineBuffer", () => {
  it("keeps a stable total once old lines are dropped", () => {
    const b = new LineBuffer(3);
    for (let i = 0; i < 10; i++) b.push(`line${i}`);
    expect(b.total).toBe(10);
    expect(b.droppedCount).toBe(7);
    expect(b.tail(3)).toEqual(["line7", "line8", "line9"]);
  });
  it("clamps a slice that asks for dropped lines", () => {
    const b = new LineBuffer(3);
    for (let i = 0; i < 10; i++) b.push(`line${i}`);
    const s = b.slice(0, 2);
    expect(s.from).toBe(7); // clamped up to what is still retained
    expect(s.lines).toEqual(["line7", "line8"]);
    expect(s.nextOffset).toBe(9);
  });

  // Finding 4: stored line length is bounded, with a visible marker.
  it("truncates an over-long stored line", () => {
    const b = new LineBuffer(10, MAX_BUFFER_CHARS, 100);
    b.push("a".repeat(10_000));
    const [line] = b.tail(1);
    expect(line.length).toBe(100);
    expect(line.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it("enforces a total character budget by dropping oldest lines", () => {
    const b = new LineBuffer(100, 250, MAX_STORED_LINE_CHARS);
    for (let i = 0; i < 50; i++) b.push("x".repeat(50)); // 2500 chars total
    expect(b.tail(1)[0]).toBe("x".repeat(50));
    // Retained text must fit the budget.
    expect(b.tail(b.total - b.droppedCount).join("").length).toBeLessThanOrEqual(250);
    // Offsets stay stable: total counts everything ever written.
    expect(b.total).toBe(50);
    const s = b.slice(48, 10);
    expect(s.lines.length).toBe(2);
    expect(s.nextOffset).toBe(50);
  });

  it("enforces the total character budget for a single retained line", () => {
    const b = new LineBuffer(100, 250, MAX_STORED_LINE_CHARS);
    b.push("x".repeat(10_000));
    expect(b.tail(1)[0].length).toBe(250);
    expect(b.tail(1)[0].endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe("PendingLineBuffer (bounded partial line, finding 4)", () => {
  it("assembles lines across chunks", () => {
    const p = new PendingLineBuffer();
    expect(p.push("hel")).toEqual([]);
    expect(p.push("lo\nwor")).toEqual(["hello"]);
    expect(p.push("ld\n")).toEqual(["world"]);
    expect(p.flush()).toBe("");
  });

  it("bounds a no-newline firehose with a visible marker", () => {
    const p = new PendingLineBuffer();
    // 8 MB with no newline: memory must not grow with it.
    const lines = p.push("a".repeat(8 * 1024 * 1024));
    expect(lines).toEqual([]);
    const held = p.flush();
    expect(held.length).toBe(MAX_PENDING_LINE_CHARS);
    expect(held.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(p.flush()).toBe("");
  });

  it("still completes the line when bytes keep flowing, and starts fresh", () => {
    const p = new PendingLineBuffer();
    p.push("a".repeat(MAX_PENDING_LINE_CHARS * 2)); // over cap, marked
    const done = p.push("\nnext line\n");
    expect(done.length).toBe(2);
    expect(done[0].length).toBe(MAX_PENDING_LINE_CHARS);
    expect(done[0].endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(done[1]).toBe("next line");
    // The next partial accumulates from zero, not from the marked line.
    expect(p.push("fresh")).toEqual([]);
    expect(p.flush()).toBe("fresh");
  });

  it("flushes the capped pending line when the job closes mid-line", () => {
    const p = new PendingLineBuffer();
    p.push("a".repeat(MAX_PENDING_LINE_CHARS + 5));
    const last = p.flush();
    expect(last.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(last.length).toBe(MAX_PENDING_LINE_CHARS);
    expect(p.flush()).toBe("");
  });
});

describe("evaluateExit", () => {
  it("gives a crash the urgent lane and a clean exit the polite one", () => {
    expect(evaluateExit(1, { exit: true, match: [] })).toMatchObject({ kind: "exit", lane: "now" });
    expect(evaluateExit(0, { exit: true, match: [] })).toMatchObject({ kind: "exit", lane: "soon" });
  });
  it("stays silent when exit waking is off", () => {
    expect(evaluateExit(1, { exit: false, match: [] })).toBeNull();
  });
});

describe("findMatch + evaluateMatch", () => {
  const rules = { exit: true, match: ["Traceback", "val_loss="] };

  it("finds the matching pattern", () => {
    expect(findMatch("  Traceback (most recent call last)", rules)).toBe("Traceback");
    expect(findMatch("epoch 2 val_loss=0.4", rules)).toBe("val_loss=");
    expect(findMatch("all quiet", rules)).toBeNull();
  });

  it("routes an error-ish line to the urgent lane and a progress line to the polite one", () => {
    const now = MIN_WAKE_INTERVAL_MS * 10;
    const err = evaluateMatch("Traceback", "Traceback (most recent call last)", rules, freshState(), 1, now);
    expect(err).toMatchObject({ lane: "now" });
    const ok = evaluateMatch("val_loss=", "epoch 2 val_loss=0.4", rules, freshState(), 1, now);
    expect(ok).toMatchObject({ lane: "soon" });
  });

  // The whole point of the feature: a six-hour job must not produce a turn per line.
  it("throttles to every Nth match", () => {
    const r = { exit: true, match: ["step"], everyNMatches: 10 };
    const now = MIN_WAKE_INTERVAL_MS * 10;
    const woke: number[] = [];
    for (let i = 1; i <= 25; i++) {
      // lastWakeAt stays far in the past so only the throttle is under test
      if (evaluateMatch("step", `step ${i}`, r, freshState(), i, now)) woke.push(i);
    }
    expect(woke).toEqual([10, 20]);
  });

  // A job that matches its own error pattern every second must not drive the
  // agent in a loop.
  it("suppresses a second wake inside the minimum interval", () => {
    const now = 1_000_000;
    const state = freshState({ lastWakeAt: now - 1000 });
    expect(evaluateMatch("Traceback", "Traceback", rules, state, 1, now)).toBeNull();
    const later = freshState({ lastWakeAt: now - MIN_WAKE_INTERVAL_MS - 1 });
    expect(evaluateMatch("Traceback", "Traceback", rules, later, 1, now)).not.toBeNull();
  });
});

describe("evaluateSilence", () => {
  const rules = { exit: true, match: [], silenceMs: 60_000 };

  it("fires once the quiet period is exceeded", () => {
    const now = 500_000;
    expect(evaluateSilence(rules, freshState(), now - 61_000, now)).toMatchObject({
      kind: "silence",
      lane: "soon",
    });
  });
  it("stays quiet before the threshold", () => {
    const now = 500_000;
    expect(evaluateSilence(rules, freshState(), now - 10_000, now)).toBeNull();
  });
  it("does not re-fire for the same quiet period", () => {
    const now = 500_000;
    const state = freshState({ stallNotified: true });
    expect(evaluateSilence(rules, state, now - 61_000, now)).toBeNull();
  });
  // A job that is legitimately silent from the start (a long compile) is not stalled.
  it("does not fire for a job that has never produced output", () => {
    expect(evaluateSilence(rules, freshState(), null, 500_000)).toBeNull();
  });
});

describe("laneDelivery", () => {
  it("maps lanes onto pi's delivery modes", () => {
    expect(laneDelivery("now")).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(laneDelivery("soon")).toEqual({ deliverAs: "followUp", triggerTurn: true });
    expect(laneDelivery("idle")).toEqual({ deliverAs: "nextTurn" });
  });
});

describe("formatWakePayload", () => {
  const base = {
    id: "job1",
    label: "finetune",
    command: "python train.py",
    elapsedMs: 2_400_000,
    lines: ["epoch 3", "val_loss=0.4"],
    totalLines: 98_000,
  };

  it("is bounded: it reports the total but carries only the excerpt", () => {
    const out = formatWakePayload({
      ...base,
      event: { kind: "match", lane: "soon", reason: 'matched "val_loss="' },
    });
    expect(out).toContain("98000 lines");
    expect(out).toContain("val_loss=0.4");
    expect(out).not.toContain("epoch 1"); // never in `lines`, so never in the payload
    expect(out.length).toBeLessThan(2000);
  });

  it("points at ShellLog while the job is alive, and does not once it has exited", () => {
    const running = formatWakePayload({
      ...base,
      event: { kind: "match", lane: "soon", reason: "matched" },
    });
    expect(running).toContain("ShellLog");
    const done = formatWakePayload({
      ...base,
      exitCode: 0,
      event: { kind: "exit", lane: "soon", reason: "exited 0" },
    });
    expect(done).toContain("exit 0");
    expect(done).not.toContain("still running");
  });

  // Finding 4: every field of the payload is bounded and every cut is visible.
  it("truncates oversized display fields and excerpt lines", () => {
    const out = formatWakePayload({
      ...base,
      label: "L".repeat(100_000),
      command: "C".repeat(100_000),
      lines: ["E".repeat(100_000)],
      event: { kind: "match", lane: "soon", reason: "matched" },
    });
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.length).toBeLessThanOrEqual(MAX_WAKE_PAYLOAD_CHARS);
  });

  it("enforces the total payload cap", () => {
    // 30 short-ish lines (each under the per-line excerpt cap) whose joined
    // body still exceeds the total payload cap.
    const out = formatWakePayload({
      ...base,
      lines: Array.from({ length: 30 }, () => "E".repeat(400)),
      event: { kind: "match", lane: "soon", reason: "matched" },
    });
    expect(out.length).toBe(MAX_WAKE_PAYLOAD_CHARS);
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("scales the unit to the magnitude", () => {
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(125_000)).toBe("2m05s");
    expect(formatElapsed(7_500_000)).toBe("2h05m");
  });
});

describe("wrapWithParentWatchdog", () => {
  const wrapped = wrapWithParentWatchdog("python train.py", 4242, 5);

  it("polls the real parent pid and kills its own group", () => {
    expect(wrapped).toContain("__pi_review_parent=4242");
    expect(wrapped).toContain('kill -0 "$__pi_review_parent"');
    // `kill -TERM 0` targets the JOB's group — safe only because the job is
    // spawned detached. It must never be a bare pid that could be ours.
    expect(wrapped).toContain("kill -TERM 0");
  });

  it("runs the command and preserves its exit status", () => {
    expect(wrapped).toContain("python train.py");
    expect(wrapped).toContain("exit $__pi_review_rc");
  });

  it("stops the watchdog on the normal path so nothing is left behind", () => {
    expect(wrapped).toContain('kill "$__pi_review_watchdog"');
    expect(wrapped).toContain('wait "$__pi_review_watchdog"');
  });
});
