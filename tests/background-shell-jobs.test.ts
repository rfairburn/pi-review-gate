/*
 * Test cases derived from Little Coder's bg-shell extension.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */
import { after, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownershipAcknowledgement, ownershipVerdict, readOwnershipRecord } from "../src/background-shell/ownership";
import {
  findWindowsExecutableMatches,
  findWindowsPowerShell,
  isWindowsAppsPackagePath,
  selectWindowsPowerShellForJobs,
  selectWindowsPowerShellForJobsAsync,
  type WindowsWhereProbe,
} from "../src/background-shell/shell";
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
  msixWorkloadScript,
  msixWorkloadVariableName,
  wrapWithMsixPowerShellLauncher,
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
    expect(laneDelivery("soon")).toEqual({ deliverAs: "steer", triggerTurn: true });
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

  it("carries none of the Store/MSIX launch workaround on the ordinary route (#800)", () => {
    // Ordinary PowerShell 7 and Windows PowerShell 5.1 keep their plain records
    // and never see the desktop-app policy, the launcher class, or the route tag.
    for (const msixOnly of ["0x20012", "PiReviewMsixLaunch", "PiReviewBgMsixWatch", "__pi_mark", " msix", " uncontained"]) {
      expect(wrapped.includes(msixOnly), `ordinary wrapper has no ${msixOnly}`).toBe(false);
    }
    expect(wrapped).toContain('Set-Content -LiteralPath $mk -Value "$PID running"');
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
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000) at offset 16 of
    // JOBOBJECT_BASIC_LIMIT_INFORMATION, set via JobObjectExtendedLimitInformation
    // (class 9; 144 bytes on 64-bit, 112 on 32-bit). No breakaway flag is set,
    // so processes in the job cannot create processes outside it.
    expect(wrapped).toContain("$size = 144; if ([IntPtr]::Size -eq 4) { $size = 112 }");
    expect(wrapped).toContain("WriteInt32($lim.AddrOfPinnedObject(), 16, 0x2000)");
    expect(wrapped).toContain("SetInformationJobObject($job, 9, $lim.AddrOfPinnedObject(), $size)");
    // The root is assigned from this shell's read-only $PID at runtime, through
    // the identity-guarded owned-root method (full access mask unchanged).
    expect(wrapped).toContain(".Replace('__PI_ROOT__', [string]$PID)");
    expect(wrapped).toContain("[PiReviewBgJobApi]::AssignOwnedRoot($job, __PI_ROOT__, __PI_ROOT_TICKS__)");
    expect(wrapped).toContain("OpenProcess(0x1FFFFF,false,pid)");
  });

  it("writes the running record only AFTER the job object exists and the root is assigned", () => {
    const assign = wrapped.indexOf("[PiReviewBgJobApi]::AssignOwnedRoot($job, __PI_ROOT__, __PI_ROOT_TICKS__)");
    const refused = wrapped.indexOf("if (-not $assigned) { exit 1 }");
    const firstRunning = wrapped.indexOf('Set-Content -LiteralPath $mk -Value "$PID running"');
    expect(assign !== -1 && refused !== -1 && firstRunning !== -1).toBe(true);
    expect(assign < refused && refused < firstRunning).toBe(true);
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
    expect(wrapped).toContain("[PiReviewBgJobQuery]::QueryInformationJobObject($job, 1, $b, 48, [IntPtr]::Zero)");
    expect(wrapped).toContain("ReadInt32($b, 40)");
    // One shared accounting helper: -1 is a FAILED query, never "empty".
    expect(wrapped).toContain("function __pi_active()");
    expect(wrapped).toContain("if ($a -eq 0) { return $true }; if ($a -lt 0) { return $false }");
    expect(wrapped).toContain("if ($__pi_live -lt 0) { exit 1 }");
    expect(wrapped).toContain('Set-Content -LiteralPath $mk -Value "$PID released"');
    // The root check uses pid AND creation time (a reused pid cannot release it).
    expect(wrapped).toContain("$rt.StartTime.Ticks -eq __PI_ROOT_TICKS__");
    expect(wrapped).toContain(".Replace('__PI_ROOT_TICKS__', [string]$__pi_review_root_ticks)");
  });

  it("terminates the whole job on stop-file or host death, through the job handle only", () => {
    // Stop file (ShellStop / shutdown) and host death both TerminateJobObject —
    // reaching descendants that outlived the root. No taskkill anywhere: after
    // the root exits its pid may identify an unrelated process.
    expect(wrapped).toContain("if ($__pi_stopPending -or (Test-Path -LiteralPath $st))");
    const terminations = wrapped.split("TerminateJobObject($job, 1)").length - 1;
    expect(terminations === 2, `stop and host-death paths both terminate the job (found ${terminations})`).toBe(true);
    // The stop path acts on the result and confirms the job empty before it
    // claims termination; an unverified request keeps the watchdog (and the
    // job's kill-on-close backstop) alive instead.
    expect(wrapped).toContain("$__pi_term = [PiReviewBgJobApi]::TerminateJobObject($job, 1)");
    expect(wrapped).toContain('if ($__pi_term -and (__pi_empty 2000)) { try { Set-Content -LiteralPath $mk -Value "$PID terminated"');
    // An unconfirmed stop keeps the watchdog retrying and keeps the ordinary
    // release branch out of the picture, so a later empty job cannot publish
    // `released` on top of a pending stop request.
    expect(wrapped).toContain("$__pi_stopPending = $true;");
    expect(wrapped).toContain("if ($__pi_stopPending) { continue };");
    // The latch is initialised ONCE, before the poll loop, so an unconfirmed
    // stop keeps being retried even if the stop file later disappears.
    const latchInit = wrapped.indexOf("$__pi_stopPending = $false; ");
    const loop = wrapped.indexOf("while ($true) { Start-Sleep -Seconds 5;");
    expect(latchInit !== -1 && loop !== -1 && latchInit < loop, "stop latch initialised before the loop").toBe(true);
    expect(wrapped.split("$__pi_stopPending = $false").length - 1, "latch initialised exactly once").toBe(1);
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

/** The producer's one-line kernel32 class text, exactly as embedded in the
 *  watchdog's single-quoted Add-Type string (apostrophe-free by construction). */
function producerJobApiClass(script: string): string {
  const match = script.match(/Add-Type -TypeDefinition '([^']*public static class PiReviewBgJobApi \{[^']*)'/);
  if (!match) throw new Error("PiReviewBgJobApi class text not found in the wrapper");
  return match[1];
}

/** Brace-matched body of the ONE C# method declared by `signature`. */
function csharpMethodBody(cls: string, signature: string): string {
  const start = cls.indexOf(signature);
  if (start === -1 || cls.indexOf(signature, start + 1) !== -1) {
    throw new Error(`expected exactly one declaration: ${signature}`);
  }
  const open = cls.indexOf("{", start + signature.length);
  let depth = 0;
  for (let i = open; i < cls.length; i++) {
    if (cls[i] === "{") depth++;
    if (cls[i] === "}" && --depth === 0) return cls.slice(open, i + 1);
  }
  throw new Error(`unterminated method body: ${signature}`);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("wrapWithPowerShellWatchdog root identity guard (Windows, #705)", () => {
  const COMMAND = "Write-Output hi; exit 0";
  const wrapped = wrapWithPowerShellWatchdog(COMMAND, 4242, 5, {
    markerPath: "C:\\pi-review-bg\\guard.job",
    stopPath: "C:\\pi-review-bg\\guard.stop",
  });
  const hereStart = wrapped.indexOf("$__pi_review_watchdog_command = @'");
  const hereEnd = wrapped.indexOf("\n'@", hereStart);
  const watchdog = wrapped.slice(hereStart, hereEnd);
  const cls = producerJobApiClass(watchdog);
  const CORE_SIGNATURE = "public static bool AssignRootIfIdentity(IntPtr j,IntPtr h,long t)";
  const OWNED_SIGNATURE = "public static bool AssignOwnedRoot(IntPtr j,int pid,long t)";
  const core = csharpMethodBody(cls, CORE_SIGNATURE);
  const owned = csharpMethodBody(cls, OWNED_SIGNATURE);

  it("validates creation identity through the handle before the sole job assignment", () => {
    const steps = [
      "if (h == IntPtr.Zero) { return false; }",
      "if (!GetProcessTimes(h,out c,out x,out k,out u)) { return false; }",
      "try { s = DateTime.FromFileTime(c).Ticks; } catch { return false; }",
      "if (s != t) { return false; }",
      "return AssignProcessToJobObject(j,h); }",
    ];
    let previous = -1;
    for (const step of steps) {
      const at = core.indexOf(step);
      expect(at > previous, `core step in order: ${step}`).toBe(true);
      previous = at;
    }
    // The query and the assignment use the SAME handle parameter, and the
    // assignment is the core's last statement, reached only past every check.
    expect(occurrences(core, "AssignProcessToJobObject("), "one assignment in the core").toBe(1);
    expect(core.endsWith("return AssignProcessToJobObject(j,h); }"), "assignment is the final step").toBe(true);
    expect(occurrences(core, "OpenProcess("), "the core never opens its own handle").toBe(0);
    // The core is the ONLY assignment call site in the class: removing the
    // extern declaration and the core body leaves no other call.
    const rest = cls
      .replace("public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);", "")
      .replace(core, "");
    expect(rest).not.toContain("AssignProcessToJobObject(");
  });

  it("opens the root once, delegates to the guard, and closes the same handle in finally", () => {
    expect(occurrences(owned, "OpenProcess("), "one open").toBe(1);
    const open = owned.indexOf("IntPtr h = OpenProcess(0x1FFFFF,false,pid);");
    const zero = owned.indexOf("if (h == IntPtr.Zero) { return false; }");
    const guarded = owned.indexOf("try { return AssignRootIfIdentity(j,h,t); } finally { CloseHandle(h); }");
    expect(open !== -1 && open < zero && zero < guarded, "open, zero check, then guarded delegation").toBe(true);
    expect(occurrences(owned, "CloseHandle("), "one release").toBe(1);
    // Delegation only: the owned method neither re-implements nor bypasses
    // the guard.
    expect(owned).not.toContain("GetProcessTimes(");
    expect(owned).not.toContain("AssignProcessToJobObject(");
    // Within the class, the guard core is reached only through the owned method.
    expect(occurrences(cls, "AssignRootIfIdentity("), "core declared once, called once").toBe(2);
  });

  it("invokes only the owned guard from the watchdog and exits on refusal or exception before the running record", () => {
    const boundary =
      "$assigned = $false; try { $assigned = [PiReviewBgJobApi]::AssignOwnedRoot($job, __PI_ROOT__, __PI_ROOT_TICKS__) } catch {}; if (-not $assigned) { exit 1 }; ";
    expect(occurrences(watchdog, boundary), "fail-closed exception boundary").toBe(1);
    const at = watchdog.indexOf(boundary);
    const configured = watchdog.indexOf("if (-not $configured) { exit 1 }");
    const firstRunning = watchdog.indexOf('Set-Content -LiteralPath $mk -Value "$PID running"');
    expect(configured !== -1 && configured < at, "job configured before the guarded assignment").toBe(true);
    expect(at + boundary.length <= firstRunning, "refusal exits before the running record").toBe(true);
    // No raw open/assign sequence or direct guard-core call outside the class.
    const script = watchdog.replace(cls, "");
    expect(occurrences(script, "[PiReviewBgJobApi]::AssignOwnedRoot("), "single production call").toBe(1);
    for (const raw of ["::AssignProcessToJobObject(", "::OpenProcess(", "::AssignRootIfIdentity(", "::GetProcessTimes(", "::CloseHandle("]) {
      expect(script, raw).not.toContain(raw);
    }
  });

  it("reuses the single captured root identity without new representations", () => {
    const tokens = new Set(wrapped.match(/__PI_[A-Z]+(?:_[A-Z]+)*__/g) ?? []);
    expect([...tokens].sort()).toEqual(["__PI_MARKER__", "__PI_ROOT_TICKS__", "__PI_ROOT__", "__PI_STOP__", "__PI_TICKS__"]);
    expect(occurrences(wrapped, "$__pi_review_root_ticks = "), "root identity captured once").toBe(1);
    expect(occurrences(wrapped, ".Replace('__PI_ROOT_TICKS__', [string]$__pi_review_root_ticks)"), "substituted once").toBe(1);
    // The assignment guard and the later root-liveness check consume the
    // same token; nothing else does.
    expect(occurrences(watchdog, "__PI_ROOT_TICKS__"), "guard + liveness").toBe(2);
    expect(watchdog).toContain("$rt.StartTime.Ticks -eq __PI_ROOT_TICKS__");
  });

  it("keeps the class C# 5 / Windows PowerShell 5.1 compatible and token-free", () => {
    expect(cls.includes("\n"), "one line").toBe(false);
    expect(cls).not.toContain("__PI_");
    for (const modern of ["=>", "?.", "??", "$\"", "out var", "nameof", "is not"]) {
      expect(cls, modern).not.toContain(modern);
    }
    expect(cls).toContain("[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr h,out long c,out long x,out long k,out long u);");
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

// ── Background-job shell selection (#800) ───────────────────────────────
//
// DETERMINISTIC FIXTURES ONLY: every case below injects the `where` runner,
// the existence check, and the environment, so no shell is started and the
// real host PATH is neither read nor reordered. The native Store (MSIX)
// evidence lives in background-shell-windows.test.ts and runs against the real
// package; nothing here stands in for it.

/** A synthetic Windows host: `where` answers from fixed ordered lists, every
 *  existence check answers from a fixed set, and every lookup is recorded so
 *  laziness ("no unrelated candidate is consulted") is assertable. */
function discoveryFixture(options: {
  pwsh?: string[];
  powershell?: string[];
  existing?: string[];
  env?: Record<string, string>;
}) {
  const lookups: string[] = [];
  const stats: string[] = [];
  const existing = new Set((options.existing ?? []).map((path) => path.toLowerCase()));
  return {
    lookups,
    stats,
    deps: {
      runWhere: (executable: string): WindowsWhereProbe => {
        lookups.push(executable);
        const lines = executable === "pwsh.exe" ? options.pwsh : options.powershell;
        return lines && lines.length > 0 ? { status: 0, stdout: lines.join("\r\n") + "\r\n" } : { status: 1, stdout: "" };
      },
      // The same answers, delivered asynchronously (after a timer turn), for
      // the production ShellStart path.
      runWhereAsync: (executable: string): Promise<WindowsWhereProbe> =>
        new Promise((resolve) => setTimeout(() => {
          lookups.push(executable);
          const lines = executable === "pwsh.exe" ? options.pwsh : options.powershell;
          resolve(lines && lines.length > 0 ? { status: 0, stdout: lines.join("\r\n") + "\r\n" } : { status: 1, stdout: "" });
        }, 20)),
      pathExists: (path: string): boolean => {
        stats.push(path);
        return existing.has(path.toLowerCase());
      },
      env: options.env ?? {},
    },
  };
}

// Generic user profile: the owner-observed shapes, never a real account name.
const FAMILY_ALIAS = "C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe";
const GENERIC_ALIAS = "C:\\Users\\example\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
const PACKAGE_IMAGE = "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\pwsh.exe";
const STANDARD_PWSH7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const SYSTEM32_PS51 = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const STANDARD_ENV = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };

describe("Windows background-job shell selection (#800, injected fixtures)", () => {
  it("recognizes both Store alias forms and the package image as packaged, and nothing else", () => {
    expect(isWindowsAppsPackagePath(FAMILY_ALIAS), "package-family alias subdirectory").toBe(true);
    expect(isWindowsAppsPackagePath(GENERIC_ALIAS), "generic app-execution alias").toBe(true);
    expect(isWindowsAppsPackagePath(PACKAGE_IMAGE), "direct %ProgramFiles%\\WindowsApps package image").toBe(true);
    expect(isWindowsAppsPackagePath("c:/users/example/appdata/local/microsoft/windowsapps/pwsh.exe"), "case/separator-insensitive").toBe(true);
    expect(
      isWindowsAppsPackagePath("D:\\WindowsApps\\Microsoft.PowerShell_7.7.0.0_x64__8wekyb3d8bbwe\\pwsh.exe"),
      "a package image under another volume's WindowsApps root",
    ).toBe(true);
    // A relocated profile: the alias directory is recognised through LOCALAPPDATA.
    const relocated = "E:\\Profiles\\example\\Local\\Microsoft\\WindowsApps\\pwsh.exe";
    expect(isWindowsAppsPackagePath(relocated, { LOCALAPPDATA: "E:\\Profiles\\example\\Local" })).toBe(true);
    expect(isWindowsAppsPackagePath(relocated, {}), "same shape without that LOCALAPPDATA is not an alias").toBe(false);
    for (const ordinary of [
      STANDARD_PWSH7,
      "D:\\tools\\pwsh-7.7.0-win-x64\\pwsh.exe",
      SYSTEM32_PS51,
      "C:\\WindowsAppsTools\\pwsh.exe",
      // A directory merely NAMED WindowsApps is not a package location.
      "D:\\Tools\\WindowsApps\\pwsh.exe",
      "D:\\Tools\\WindowsApps\\pwsh-7.7.0-win-x64\\pwsh.exe",
      "D:\\Tools\\Microsoft\\WindowsApps\\pwsh.exe",
      "D:\\WindowsApps\\pwsh.exe",
    ]) {
      expect(isWindowsAppsPackagePath(ordinary, {}), `${ordinary} is ordinary`).toBe(false);
    }
  });

  it("keeps an unpackaged ZIP under an unrelated WindowsApps directory on the ordinary route, even behind a real alias", () => {
    const zip = "D:\\Tools\\WindowsApps\\pwsh.exe";
    const behindAlias = discoveryFixture({ pwsh: [GENERIC_ALIAS, zip], existing: [GENERIC_ALIAS, zip, SYSTEM32_PS51], env: { SystemRoot: "C:\\Windows" } });
    expect(selectWindowsPowerShellForJobs(behindAlias.deps)).toEqual({ executable: zip, route: "ordinary" });
    const alone = discoveryFixture({ pwsh: [zip], existing: [zip], env: { SystemRoot: "C:\\Windows" } });
    expect(selectWindowsPowerShellForJobs(alone.deps), "never routed to the Store launcher").toEqual({ executable: zip, route: "ordinary" });
  });

  it("production ShellStart selection is asynchronous and makes the same decisions", async () => {
    const zip = "D:\\tools\\pwsh-7.7.0-win-x64\\pwsh.exe";
    const cases: Array<Parameters<typeof discoveryFixture>[0]> = [
      { pwsh: [FAMILY_ALIAS, STANDARD_PWSH7, GENERIC_ALIAS], existing: [FAMILY_ALIAS, STANDARD_PWSH7, GENERIC_ALIAS], env: STANDARD_ENV },
      { pwsh: [GENERIC_ALIAS, zip], existing: [GENERIC_ALIAS, zip], env: { SystemRoot: "C:\\Windows" } },
      { pwsh: [GENERIC_ALIAS], powershell: [SYSTEM32_PS51], existing: [GENERIC_ALIAS, SYSTEM32_PS51], env: STANDARD_ENV },
      { powershell: [SYSTEM32_PS51], existing: [SYSTEM32_PS51], env: STANDARD_ENV },
    ];
    for (const options of cases) {
      const sync = discoveryFixture(options);
      const async = discoveryFixture(options);
      let ticked = false;
      const timer = setTimeout(() => { ticked = true; }, 0);
      const pending = selectWindowsPowerShellForJobsAsync(async.deps);
      const selection = await pending;
      clearTimeout(timer);
      expect(ticked, "the event loop kept running during discovery").toBe(true);
      expect(selection).toEqual(selectWindowsPowerShellForJobs(sync.deps));
      expect(async.lookups, "same lookups, same laziness").toEqual(sync.lookups);
    }
    let message = "";
    try {
      await selectWindowsPowerShellForJobsAsync(discoveryFixture({ env: STANDARD_ENV }).deps);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("No PowerShell executable found");
    const timeouts: number[] = [];
    await selectWindowsPowerShellForJobsAsync({
      runWhereAsync: async (_executable, timeoutMs) => {
        timeouts.push(timeoutMs);
        return { error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null, stdout: "" };
      },
      pathExists: (path) => path === SYSTEM32_PS51,
      env: STANDARD_ENV,
    });
    expect(timeouts, "one retry per timed-out lookup").toEqual([5000, 15000, 5000, 15000]);
  });

  it("pins the default Store PowerShell window's where order: the unpackaged ZIP between two aliases wins", () => {
    // Exact order the Store shell itself reports for `where.exe pwsh.exe`
    // (owner-observed): family alias, same-version unpackaged ZIP, generic alias.
    const host = discoveryFixture({
      pwsh: [FAMILY_ALIAS, STANDARD_PWSH7, GENERIC_ALIAS],
      existing: [FAMILY_ALIAS, STANDARD_PWSH7, GENERIC_ALIAS, SYSTEM32_PS51],
      env: STANDARD_ENV,
    });
    const selection = selectWindowsPowerShellForJobs(host.deps);
    expect(selection).toEqual({ executable: STANDARD_PWSH7, route: "ordinary" });
    // Lazy: the first ordinary candidate ends the search; Windows PowerShell is
    // never looked up and no further location is stat-ed.
    expect(host.lookups).toEqual(["pwsh.exe"]);
    // Pi's lazy interactive finder is untouched and still answers the first line.
    const pi = discoveryFixture({
      pwsh: [FAMILY_ALIAS, STANDARD_PWSH7, GENERIC_ALIAS],
      existing: [FAMILY_ALIAS, STANDARD_PWSH7, GENERIC_ALIAS],
      env: STANDARD_ENV,
    });
    expect(findWindowsPowerShell(pi.deps)).toBe(FAMILY_ALIAS);
  });

  it("prefers an unpackaged ZIP on PATH outside ProgramFiles behind a Store alias, with no standard install", () => {
    const zip = "D:\\tools\\pwsh-7.7.0-win-x64\\pwsh.exe";
    for (const env of [STANDARD_ENV, { SystemRoot: "C:\\Windows" }]) {
      const host = discoveryFixture({
        pwsh: [GENERIC_ALIAS, zip],
        // The standard install location does NOT exist (or ProgramFiles is unset).
        existing: [GENERIC_ALIAS, zip, SYSTEM32_PS51],
        env,
      });
      expect(selectWindowsPowerShellForJobs(host.deps)).toEqual({ executable: zip, route: "ordinary" });
      expect(host.stats.some((path) => path.toLowerCase() === STANDARD_PWSH7.toLowerCase()), "standard location not needed").toBe(false);
    }
  });

  it("prefers the standard PowerShell 7 install over a Store alias that is the only where result", () => {
    const host = discoveryFixture({ pwsh: [GENERIC_ALIAS], existing: [GENERIC_ALIAS, STANDARD_PWSH7], env: STANDARD_ENV });
    expect(selectWindowsPowerShellForJobs(host.deps)).toEqual({ executable: STANDARD_PWSH7, route: "ordinary" });
    expect(host.lookups).toEqual(["pwsh.exe"]);
  });

  it("keeps discovery order within a class", () => {
    const first = "D:\\a\\pwsh.exe";
    const second = "D:\\b\\pwsh.exe";
    const ordinary = discoveryFixture({ pwsh: [GENERIC_ALIAS, first, second], existing: [GENERIC_ALIAS, first, second], env: STANDARD_ENV });
    expect(selectWindowsPowerShellForJobs(ordinary.deps).executable).toBe(first);
    const packaged = discoveryFixture({ pwsh: [FAMILY_ALIAS, GENERIC_ALIAS], existing: [FAMILY_ALIAS, GENERIC_ALIAS], env: STANDARD_ENV });
    expect(selectWindowsPowerShellForJobs(packaged.deps)).toEqual({ executable: FAMILY_ALIAS, route: "msix" });
  });

  it("uses Store PowerShell 7 on the MSIX route ahead of a standard Windows PowerShell 5.1", () => {
    const host = discoveryFixture({
      pwsh: [GENERIC_ALIAS],
      powershell: [SYSTEM32_PS51],
      existing: [GENERIC_ALIAS, SYSTEM32_PS51],
      env: STANDARD_ENV,
    });
    expect(selectWindowsPowerShellForJobs(host.deps)).toEqual({ executable: GENERIC_ALIAS, route: "msix" });
    // An unrelated candidate is not consulted once a PowerShell 7 route exists.
    expect(host.lookups).toEqual(["pwsh.exe"]);
    // The direct package image alone is the same package on the same route.
    const direct = discoveryFixture({ pwsh: [PACKAGE_IMAGE], existing: [PACKAGE_IMAGE], env: STANDARD_ENV });
    expect(selectWindowsPowerShellForJobs(direct.deps)).toEqual({ executable: PACKAGE_IMAGE, route: "msix" });
  });

  it("falls back to Windows PowerShell 5.1 on the ordinary route only when no PowerShell 7 exists", () => {
    const where = discoveryFixture({ powershell: [SYSTEM32_PS51], existing: [SYSTEM32_PS51], env: STANDARD_ENV });
    expect(selectWindowsPowerShellForJobs(where.deps)).toEqual({ executable: SYSTEM32_PS51, route: "ordinary" });
    expect(where.lookups).toEqual(["pwsh.exe", "powershell.exe"]);
    const location = discoveryFixture({ existing: [SYSTEM32_PS51], env: STANDARD_ENV });
    expect(selectWindowsPowerShellForJobs(location.deps)).toEqual({ executable: SYSTEM32_PS51, route: "ordinary" });
  });

  it("fails closed with the prerequisite error when nothing resolves", () => {
    let message = "";
    try {
      selectWindowsPowerShellForJobs(discoveryFixture({ env: STANDARD_ENV }).deps);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("No PowerShell executable found");
  });

  it("lists every existing where line once, with one retry only for a timeout", () => {
    const missing = "D:\\gone\\pwsh.exe";
    const host = discoveryFixture({ pwsh: [GENERIC_ALIAS, missing, STANDARD_PWSH7, GENERIC_ALIAS], existing: [GENERIC_ALIAS, STANDARD_PWSH7] });
    expect(findWindowsExecutableMatches("pwsh.exe", host.deps)).toEqual([GENERIC_ALIAS, STANDARD_PWSH7]);
    const timeouts: number[] = [];
    const timedOut = (): WindowsWhereProbe => ({ error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }), status: null, stdout: "" });
    expect(findWindowsExecutableMatches("pwsh.exe", {
      runWhere: (_executable, timeoutMs) => { timeouts.push(timeoutMs); return timedOut(); },
      pathExists: () => true,
    })).toEqual([]);
    expect(timeouts.length, "exactly one retry").toBe(2);
  });
});

// ── Store/MSIX launcher text contract (#800) ────────────────────────────

describe("wrapWithMsixPowerShellLauncher (#800, generated text)", () => {
  const COMMAND = "Write-Output MSIX-CANARY; exit 0";
  const ownership = {
    markerPath: "C:\\pi-review-bg\\msix.job",
    stopPath: "C:\\pi-review-bg\\msix.stop",
    workloadVariable: msixWorkloadVariableName("0123456789abcdef"),
  };
  const launcher = wrapWithMsixPowerShellLauncher(4242, 5, ownership);
  const watchdogStart = launcher.indexOf("$__pi_review_watchdog_command = @'\n") + "$__pi_review_watchdog_command = @'\n".length;
  const watchdog = launcher.slice(watchdogStart, launcher.indexOf("\n'@", watchdogStart));
  const classStart = launcher.indexOf("Add-Type -TypeDefinition '") + "Add-Type -TypeDefinition '".length;
  const cls = launcher.slice(classStart, launcher.indexOf("' -ErrorAction Stop } catch { __pi_review_fail 'launcher-interop' }"));

  it("carries no user command text; the workload script carries it with the ordinary status mapping", () => {
    expect(launcher).not.toContain("MSIX-CANARY");
    const workload = msixWorkloadScript(COMMAND);
    expect(workload.split("\n")[0]).toBe(POWERSHELL_UTF8_PREFIX);
    // Byte-identical command block and exit mapping to the ordinary wrapper.
    const ordinary = wrapWithPowerShellWatchdog(COMMAND, 4242, 5, { markerPath: "m", stopPath: "s" });
    const tail = workload.slice(workload.indexOf("$__pi_review_status = @($null, $null)"));
    expect(ordinary.endsWith(tail), "same command/status block as the ordinary route").toBe(true);
    expect(ownership.workloadVariable).toBe("PI_REVIEW_BG_WORKLOAD_0123456789abcdef");
  });

  it("removes the workload variable before the command can run and before the watchdog starts", () => {
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)'\)\) \{ __pi_review_fail/.exec(launcher)?.[1];
    expect(typeof encoded, "workload bootstrap is encoded").toBe("string");
    const bootstrap = Buffer.from(encoded!, "base64").toString("utf16le");
    const removed = bootstrap.indexOf("[Environment]::SetEnvironmentVariable('PI_REVIEW_BG_WORKLOAD_0123456789abcdef', $null)");
    const run = bootstrap.indexOf(". ([scriptblock]::Create($__pi_review_workload))");
    expect(removed !== -1 && run !== -1 && removed < run, "bootstrap clears the variable first").toBe(true);
    const launcherClears = launcher.indexOf("[Environment]::SetEnvironmentVariable('PI_REVIEW_BG_WORKLOAD_0123456789abcdef', $null)");
    expect(launcherClears > launcher.indexOf(".Prepare(") && launcherClears < launcher.indexOf(".StartWatchdog("), "launcher clears before the watchdog").toBe(true);
  });

  it("applies the desktop-app policy and the stdio handle list, never the job list", () => {
    expect(cls).toContain("(IntPtr)0x20012"); // PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY
    expect(cls).toContain("Marshal.WriteInt32(policy, 2)"); // ..._BREAKAWAY_DISABLE_PROCESS_TREE
    expect(cls).toContain("(IntPtr)0x20002"); // PROC_THREAD_ATTRIBUTE_HANDLE_LIST
    expect(/0x2000[dD]/.test(launcher), "PROC_THREAD_ATTRIBUTE_JOB_LIST is not used").toBe(false);
    // Workload: CREATE_SUSPENDED | CREATE_NO_WINDOW (| EXTENDED_STARTUPINFO_PRESENT inside Launch).
    expect(cls).toContain("Launch(arguments, std, std, true, 0x08000004, \"workload-create\", out info)");
    expect(cls).not.toContain("true, 0x00000004, \"workload-create\"");
    // Watchdog: no policy, CREATE_NO_WINDOW, only job/root/null handles, null stdio.
    expect(cls).toContain("Launch(arguments, new IntPtr[] { inheritJob, inheritRoot, nul }, new IntPtr[] { nul, nul, nul }, false, 0x08000000, \"watchdog-spawn\", out info)");
    expect(cls).toContain("DuplicateHandle(self, root, self, out inheritRoot, 0x00101000, true, 0)");
    // Kill-on-close only; exact handle assignment, then membership through it.
    expect(cls).toContain("BitConverter.GetBytes(0x2000).CopyTo(limits, 16)");
    expect(cls).toContain("AssignProcessToJobObject(job, root)");
    expect(cls).toContain("IsProcessInJob(root, job, out member)");
    // Same package and image as this identified MSIX process.
    expect(cls).toContain("String.Equals(rootPackage, Package, StringComparison.Ordinal)");
    expect(cls).toContain("return Fail(\"package-identity\")");
  });

  it("orders startup so the workload can resume only after identity, assignment, and the watchdog handshake", () => {
    const at = (needle: string): number => {
      const index = launcher.indexOf(needle);
      expect(index !== -1, `launcher contains ${needle}`).toBe(true);
      return index;
    };
    const order = [
      at("GetProcessById(4242)"),
      at("__pi_review_fail 'workload-text'"),
      at("__pi_review_fail 'launcher-interop'"),
      at(".Identify()"),
      at("__pi_review_fail 'stop-during-startup'"),
      at(".Prepare("),
      // The launcher's own stdin copy is closed before resume, so the workload
      // holds the only read end Node writes to (#800).
      at(".ReleaseLauncherInput()"),
      at(".StartWatchdog("),
      at("__pi_review_fail 'ownership-handshake'"),
      launcher.lastIndexOf("__pi_review_fail 'stop-during-startup'"),
      at("__pi_review_fail 'record-mismatch'"),
      at(".Resume()"),
      at(".WaitRoot()"),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1] < order[i], `startup step ${i} in order`).toBe(true);
    expect(launcher).toContain("([string]$__pi_review_launch.WatchdogPid + ' running msix')");
    // A failed release fails the start closed (never resumes with a second reader).
    expect(cls).toContain("!SetStdHandle(-10, IntPtr.Zero) || !CloseHandle(input)) { return Fail(\"launcher-stdin-release\"); }");
    expect(launcher).toContain("if (-not $__pi_review_launch.ReleaseLauncherInput()) { __pi_review_fail");
  });

  it("aborts by terminating the exact suspended root and the exact watchdog, never resuming, and withholds '0 failed' when unconfirmed", () => {
    const abort = cls.slice(cls.indexOf("public bool Abort()"), cls.indexOf("} }", cls.indexOf("public bool Abort()")) + 3);
    expect(abort).toContain("if (resumed) { return false; }");
    expect(abort).toContain("TerminateProcess(root, 1)");
    expect(abort).toContain("WaitForSingleObject(root, 5000)");
    expect(abort).not.toContain("ResumeThread");
    // Mutual exclusion with the watchdog's own record: the started watchdog is
    // ended through its exact handle, and an unconfirmed exit withholds
    // '0 failed'.
    expect(abort).toContain("TerminateProcess(watchdog, 1)");
    expect(abort).toContain("if (WaitForSingleObject(watchdog, 5000) != 0) { gone = false; }");
    expect(abort.indexOf("TerminateProcess(root, 1)") < abort.indexOf("TerminateProcess(watchdog, 1)"), "root first").toBe(true);
    expect(launcher).toContain("[void](__pi_review_record '0 failed') }");
    expect(launcher).toContain("$__pi_review_launch.WatchdogPid + '.part'");
    expect(launcher).toContain("could not both be confirmed terminated, so no completion was recorded");
    expect(launcher).toContain("is not retried on another shell");
    // Resume refuses without a live watchdog and hands it sole job ownership first.
    expect(cls).toContain("public bool Resume() { if (!WatchdogAlive()) { return Fail(\"watchdog-alive\"); } Close(ref job); if (ResumeThread(rootThread) != 1)");
  });

  it("keeps the workload's own exit status separate from ownership confirmation", () => {
    // A vanished job owner is reported on stderr; the status is never rewritten
    // (ownership is confirmed only by the host's ownershipVerdict).
    expect(launcher).toContain("' released msix'");
    expect(launcher).toContain("' terminated msix'");
    expect(launcher).toContain("The reported exit status is the workload''s own.");
    expect(launcher).not.toContain("$__pi_review_code = 1");
    expect(launcher.trimEnd().endsWith("exit $__pi_review_code")).toBe(true);
  });

  it("targets no pid and no image name for any kill", () => {
    expect(/taskkill|Stop-Process|\.Kill\(/i.test(launcher)).toBe(false);
    expect(launcher.match(/\/PID\s+\S+/g) ?? []).toEqual([]);
    // The only pid lookup is the parent identity capture (and the watchdog's
    // existing pid + creation-time host-death check).
    expect(launcher.split("GetProcessById(").length - 1).toBe(2);
    expect(cls).not.toContain("OpenProcess");
  });

  it("keeps the launcher class embeddable in a single-quoted string", () => {
    expect(cls.length > 1000).toBe(true);
    expect(cls).not.toContain("'");
    expect(cls).not.toContain("__PI_");
  });

  it("adopts and verifies the launcher's job instead of creating or assigning one", () => {
    expect(watchdog).not.toContain("[PiReviewBgJobApi]::CreateJobObjectW([IntPtr]::Zero, $null)");
    expect(watchdog).not.toContain("[PiReviewBgJobApi]::AssignOwnedRoot(");
    expect(watchdog).toContain("$job = [IntPtr][long]__PI_JOB__; $rh = [IntPtr][long]__PI_ROOT_HANDLE__;");
    const owns = watchdog.indexOf("if (-not [PiReviewBgMsixWatch]::Owns($job, $rh)) { exit 1 }");
    const running = watchdog.indexOf('try { __pi_mark "$PID running msix" } catch { exit 1 }');
    expect(owns !== -1 && running !== -1 && owns < running, "membership + kill-on-close verified before the running record").toBe(true);
    expect(watchdog).toContain("(BitConverter.ToUInt32(b,16) & 0x3800u) == 0x2000u");
    // Root liveness through the exact inherited handle; a failed wait is not exit.
    expect(watchdog).toContain("$rootAlive = ([PiReviewBgMsixWatch]::RootState($rh) -ne 0);");
    expect(watchdog).not.toContain("GetProcessById(__PI_ROOT__)");
    // Atomic records with the route tag; the stop latch and accounting stay.
    expect(watchdog).toContain("[System.IO.File]::Move($t, $mk, $true)");
    expect(watchdog).not.toContain("Set-Content");
    expect(watchdog).toContain('__pi_mark "$PID terminated msix"');
    expect(watchdog).toContain('__pi_mark "$PID released msix"');
    expect(watchdog).toContain("if ($__pi_term -and (__pi_empty 2000))");
    expect(watchdog).toContain("if ($__pi_stopPending) { continue };");
    expect(watchdog).toContain("if ($__pi_live -lt 0) { exit 1 }");
    expect(launcher).toContain(".Replace('__PI_JOB__', [string]$__pi_review_launch.JobForWatchdog).Replace('__PI_ROOT_HANDLE__', [string]$__pi_review_launch.RootForWatchdog)");
  });

  it("keeps the encoded watchdog command line within the Windows limit", () => {
    // Worst case after substitution: long marker/stop paths and 20-digit values.
    const longPath = "C:\\" + "x".repeat(240);
    const substituted = watchdog
      .replace("__PI_TICKS__", "9".repeat(20)).replace("__PI_JOB__", "9".repeat(20)).replace("__PI_ROOT_HANDLE__", "9".repeat(20))
      .replace("__PI_MARKER__", `'${longPath}'`).replace("__PI_STOP__", `'${longPath}'`);
    const commandLine = `"${"C:\\".padEnd(260, "p")}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ` +
      Buffer.from(substituted, "utf16le").toString("base64");
    expect(commandLine.length < 32_767, `watchdog command line ${commandLine.length} chars`).toBe(true);
  });
});

// ── Ownership records: route tag and explicit acknowledgement (#800) ────

describe("ownership records on the Store/MSIX route (#800)", () => {
  // One test-owned directory for every record below, removed after the suite.
  let recordDir: string | undefined;
  let recordSeq = 0;
  const write = (text: string): string => {
    recordDir ??= mkdtempSync(join(tmpdir(), "pi-review-bg-verdict-"));
    const path = join(recordDir, `record-${recordSeq++}.job`);
    writeFileSync(path, text);
    return path;
  };
  after(() => {
    if (recordDir) rmSync(recordDir, { recursive: true, force: true });
  });
  const dead = (): boolean => false;

  it("parses the msix route tag and keeps the ordinary verdict rules", () => {
    expect(readOwnershipRecord(write("4242 terminated msix"))).toEqual({ pid: 4242, state: "terminated", route: "msix" });
    expect(readOwnershipRecord(write("4242 released"))).toEqual({ pid: 4242, state: "released" });
    expect(ownershipVerdict(write("4242 terminated msix"), false, dead)).toBe("clear");
    expect(ownershipVerdict(write("4242 released msix"), false, dead)).toBe("clear");
    expect(ownershipVerdict(write("4242 running msix"), false, () => true)).toBe("running");
    // A superseded `uncontained` tag is no longer a downgrade, and never a route.
    expect(readOwnershipRecord(write("4242 released uncontained"))).toEqual({ pid: 4242, state: "released" });
  });

  it("acknowledges only records the watchdog or wrapper actually wrote", () => {
    expect(ownershipAcknowledgement(write("4242 terminated msix"))).toBe("terminated");
    expect(ownershipAcknowledgement(write("4242 released"))).toBe("released");
    expect(ownershipAcknowledgement(write("0 failed"))).toBe("failed");
    // A dead watchdog is NOT an acknowledgement, and on the Store route it is
    // not completion either: only an explicit terminal record clears there.
    expect(ownershipVerdict(write("4242 running msix"), false, dead)).toBe("unverifiable");
    expect(ownershipVerdict(write("4242 running"), false, dead), "ordinary route unchanged").toBe("clear");
    expect(ownershipAcknowledgement(write("4242 running msix"))).toBeUndefined();
    // Missing, partial, and malformed evidence acknowledge nothing.
    expect(ownershipAcknowledgement(join(tmpdir(), `pi-review-bg-missing-${process.pid}-${Date.now()}.job`))).toBeUndefined();
    expect(ownershipAcknowledgement(write("4242"))).toBeUndefined();
    expect(ownershipAcknowledgement(write(""))).toBeUndefined();
    expect(ownershipAcknowledgement(write("4242 terminat"))).toBeUndefined();
  });
});
