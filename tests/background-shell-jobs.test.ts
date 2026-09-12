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
  wrapWithPowerShellWatchdog,
  POWERSHELL_ARGS,
  POWERSHELL_UTF8_PREFIX,
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

describe("wrapWithPowerShellWatchdog (Windows, #99)", () => {
  const COMMAND = "Write-Output hi; exit 0";
  const ownership = {
    markerPath: "C:\\pi-review-bg\\test.job",
    stopPath: "C:\\pi-review-bg\\test.stop",
  };
  const wrapped = wrapWithPowerShellWatchdog(COMMAND, 4242, 5, ownership);

  it("initializes best-effort UTF-8 console output first (Pi-compatible prefix)", () => {
    expect(wrapped.split("\n")[0]).toBe(POWERSHELL_UTF8_PREFIX);
  });

  it("records '0 failed' on every pre-command failure path, then exits 1", () => {
    // The fail helper writes the record (so readiness can distinguish "nothing
    // ran" from lost evidence) and aborts before the user command runs.
    expect(wrapped).toContain(
      "function __pi_review_fail($stage) { try { Set-Content -LiteralPath $__pi_review_marker -Value '0 failed' } catch {};",

    );
    for (const stage of ["parent-identity", "self-path", "root-identity", "watchdog-spawn", "watchdog-alive", "ownership-handshake", "stop-during-startup", "record-unreadable", "record-mismatch"]) {
      const gate = wrapped.indexOf(`__pi_review_fail '${stage}'`);
      expect(gate !== -1 && gate < wrapped.indexOf(COMMAND), `${stage} aborts before the command`).toBe(true);
    }
    expect(wrapped).toContain('[Console]::Error.WriteLine("pi-review-gate: ShellStart aborted');
    expect(wrapped).not.toContain("1>&2");
    // The marker variable is defined before any failure can occur.
    expect(wrapped.indexOf("$__pi_review_marker = 'C:\\pi-review-bg\\test.job'") !== -1).toBe(true);
    expect(wrapped.indexOf("$__pi_review_marker =") < wrapped.indexOf("GetProcessById(4242)")).toBe(true);
  });

  it("establishes parent AND root creation-time identity before anything else", () => {
    const parentIdentity = wrapped.indexOf("GetProcessById(4242)");
    const parentStart = wrapped.indexOf("$__pi_review_parent_start");
    const rootTicks = wrapped.indexOf("$__pi_review_root_ticks = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.Ticks");
    const command = wrapped.indexOf(COMMAND);
    expect(parentIdentity !== -1 && parentStart !== -1 && rootTicks !== -1).toBe(true);
    expect(parentIdentity < parentStart && parentStart < rootTicks && rootTicks < command).toBe(true);
  });

  it("launches a hidden watchdog process of the same shell edition with isolated stdio", () => {
    // Same edition as the running shell (works on PowerShell 7 and 5.1 alike).
    expect(wrapped).toContain("$__pi_review_self = (Get-Process -Id $PID).Path");
    expect(wrapped).toContain("if (-not $__pi_review_self) { __pi_review_fail 'self-path' }");
    expect(wrapped).toContain("$__psi.CreateNoWindow = $true");
    expect(wrapped).toContain("$__psi.RedirectStandardInput = $true");
    expect(wrapped).toContain("$__psi.RedirectStandardOutput = $true");
    expect(wrapped).toContain("$__psi.RedirectStandardError = $true");
    expect(wrapped).toContain("[System.Diagnostics.Process]::Start($__psi)");
    // A watchdog that already exited gives no protection: fail closed BEFORE
    // the user command runs.
    expect(wrapped).toContain("if ($__pi_review_watchdog.WaitForExit(300)) { __pi_review_fail 'watchdog-alive' }");
    expect(wrapped).toContain("$__psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($__pi_review_watchdog_command))");
  });

  it("creates a kill-on-close job object and assigns the shell root to it", () => {
    // kernel32 P/Invoke compiled in-process (Add-Type works on both editions).
    expect(wrapped).toContain("CreateJobObjectW");
    expect(wrapped).toContain("AssignProcessToJobObject");
    expect(wrapped).toContain("TerminateJobObject");
    // JOB_OBJECT_LIMIT_DIE_ON_CLOSE (0x2000) at offset 16 of
    // JOBOBJECT_BASIC_LIMIT_INFORMATION, set via JobObjectExtendedLimitInformation
    // (class 9; 144 bytes on 64-bit, 112 on 32-bit). No breakaway flag is set,
    // so processes in the job cannot create processes outside it.
    expect(wrapped).toContain("$size = 144; if ([IntPtr]::Size -eq 4) { $size = 112 }");
    expect(wrapped).toContain("WriteInt32($lim.AddrOfPinnedObject(), 16, 0x2000)");
    expect(wrapped).toContain("SetInformationJobObject($job, 9, $lim.AddrOfPinnedObject(), $size)");
    // The root is assigned from this shell's read-only $PID at runtime.
    expect(wrapped).toContain(".Replace('__PI_ROOT__', [string]$PID)");
    expect(wrapped).toContain("OpenProcess(0x1FFFFF, $false, __PI_ROOT__)");
  });

  it("writes the running record only AFTER the job object exists and the root is assigned", () => {
    const assign = wrapped.indexOf("AssignProcessToJobObject($job, $rp)");
    const firstRunning = wrapped.indexOf('Set-Content -LiteralPath $mk -Value "$PID running"');
    expect(assign !== -1 && firstRunning !== -1 && assign < firstRunning).toBe(true);
  });

  it("waits for the ownership handshake before running the command (fail closed)", () => {
    const wait = wrapped.indexOf("Test-Path -LiteralPath $__pi_review_marker");
    const command = wrapped.indexOf(COMMAND);
    expect(wait !== -1 && wait < command).toBe(true);
    // Timeout or early watchdog exit: stderr diagnostic + fail, never an
    // unprotected run.
    expect(wrapped).toContain("the command was NOT run.");
    const failGate = wrapped.indexOf("__pi_review_fail 'ownership-handshake'");
    expect(failGate > wait && failGate < command).toBe(true);
  });

  it("never kills the watchdog when the shell root exits (ownership survives)", () => {
    // The old wrapper's finally-kill is exactly what orphaned descendants:
    // gone from every path, including explicit `exit N`.
    // No process-kill API anywhere in the wrapper: termination goes through
    // TerminateJobObject on the job handle only (the watchdog's own try/finally
    // blocks free P/Invoke handles, they never kill a process).
    expect(wrapped).not.toContain("Kill");
  });

  it("releases only when the job's accounting query verifies it empty, recording 'released'", () => {
    // ActiveProcesses in JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1;
    // offset 40, struct size 48) counts live members; a failed query fails
    // closed (the watchdog's death then kills every member via kill-on-close).
    expect(wrapped).toContain("[PiReviewBgJobQuery]::QueryInformationJobObject($job, 1, $accounting, 48, [IntPtr]::Zero)");
    expect(wrapped).toContain("ReadInt32($accounting, 40)");
    expect(wrapped).toContain('Set-Content -LiteralPath $mk -Value "$PID released"');
    // The root check uses pid AND creation time (a reused pid cannot release it).
    expect(wrapped).toContain("$rt.StartTime.Ticks -eq __PI_ROOT_TICKS__");
    expect(wrapped).toContain(".Replace('__PI_ROOT_TICKS__', [string]$__pi_review_root_ticks)");
  });

  it("terminates the whole job on stop-file or host death, through the job handle only", () => {
    // Stop file (ShellStop / shutdown) and host death both TerminateJobObject —
    // reaching descendants that outlived the root. No taskkill anywhere: after
    // the root exits its pid may identify an unrelated process.
    expect(wrapped).toContain("if (Test-Path -LiteralPath $st)");
    const terminations = wrapped.split("[void][PiReviewBgJobApi]::TerminateJobObject($job, 1)").length - 1;
    expect(terminations === 2, `stop and host-death paths both terminate the job (found ${terminations})`).toBe(true);
    expect(wrapped).not.toContain("taskkill");
    expect(wrapped.match(/\/PID\s+\S+/g) ?? []).toEqual([]);
    // Host death is identity-checked: pid AND creation time.
    expect(wrapped).toContain("GetProcessById(4242)");
    expect(wrapped).toContain("$pp.StartTime.Ticks -eq __PI_TICKS__");
    expect(wrapped).toContain(".Replace('__PI_TICKS__', [string]$__pi_review_parent_start.Ticks)");
  });

  it("validates the watchdog's running record before executing the command", () => {
    // A stop request that arrived during startup aborts the job, and the
    // record must be exactly this watchdog's "<pid> running".
    const stopCheck = wrapped.indexOf(`if (Test-Path -LiteralPath 'C:\\pi-review-bg\\test.stop') { __pi_review_fail 'stop-during-startup' }`);
    const recordCheck = wrapped.indexOf("$__pi_review_record -ne ([string]$__pi_review_watchdog.Id + ' running')");
    const command = wrapped.indexOf(COMMAND);
    expect(stopCheck !== -1 && recordCheck !== -1 && stopCheck < recordCheck && recordCheck < command).toBe(true);
  });

  it("substitutes the per-job marker/stop paths at runtime, quoted as PS expressions", () => {
    // Double quoting: the outer literal quotes the argument to .Replace in the
    // wrapper script (its inner quotes doubled, hence '''…''' for a plain path);
    // after substitution the watchdog script receives `$mk = '…'` so the path
    // stays a string assignment even with spaces or apostrophes.
    expect(wrapped).toContain(".Replace('__PI_MARKER__', '''C:\\pi-review-bg\\test.job''')");
    expect(wrapped).toContain(".Replace('__PI_STOP__', '''C:\\pi-review-bg\\test.stop''')");
    // The here-string text itself carries no absolute paths, so a hostile path
    // can never terminate it.
    const hereStart = wrapped.indexOf("$__pi_review_watchdog_command = @'");
    const hereEnd = wrapped.indexOf("\n'@", hereStart);
    expect(hereStart !== -1 && hereEnd > hereStart).toBe(true);
    expect(wrapped.slice(hereStart, hereEnd)).not.toContain("C:\\pi-review-bg");
  });

  it("runs the command in a child scope and captures $? before any other statement", () => {
    const block = `& {\n${COMMAND}\n$__pi_review_status[0] = $?\n$__pi_review_status[1] = $LASTEXITCODE\n}`;
    const idx = wrapped.indexOf(block);
    expect(idx !== -1, "capture the command status immediately, inside its scope").toBe(true);
    const holder = wrapped.indexOf("$__pi_review_status = @($null, $null)");
    expect(holder !== -1 && holder < idx, "mutable status holder belongs to the outer scope").toBe(true);
    expect(wrapped.slice(idx + block.length).startsWith("\n$__pi_review_invocation_ok = $?"), "capture invocation status immediately for early return").toBe(true);
    expect(wrapped).toContain("if ($null -eq $__pi_review_status[0]) { $__pi_review_status[0] = $__pi_review_invocation_ok; $__pi_review_status[1] = $LASTEXITCODE }");
  });

  it("preserves the exit status", () => {
    expect(wrapped).toContain("$__pi_review_status[1] = $LASTEXITCODE");
    expect(wrapped).toContain("if ($null -eq $__pi_review_status[1]) { $__pi_review_status[1] = 0 }");
    // Failed cmdlet (false $?, no native status) maps to nonzero.
    expect(wrapped).toContain("if (-not $__pi_review_status[0] -and $__pi_review_status[1] -eq 0) { $__pi_review_status[1] = 1 }");
    expect(wrapped.trimEnd().endsWith("exit $__pi_review_status[1]")).toBe(true);
  });

  it("stays Windows-PowerShell-5.1 compatible (no PS7-only operators)", () => {
    expect(wrapped).not.toContain("??");
    // The PS7 ternary would read `cond -f truepart -t falsepart`; guard its shape.
    expect(/\S+ -f \S+/.test(wrapped)).toBe(false);
  });
});


describe("POWERSHELL_ARGS (Pi parity, #99)", () => {
  it("matches Pi's native powershell tool invocation exactly", () => {
    expect([...POWERSHELL_ARGS]).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
  });
});
