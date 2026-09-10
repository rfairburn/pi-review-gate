/*
 * Expanded result views for the background shell tool family (#58).
 *
 * Every test drives the PRODUCTION renderers in
 * src/background-shell/result-view.ts — no test-local copy of the ideal
 * rendering. The real-process section feeds actual tool results from
 * registerBackgroundShell through the same renderers; the crafted section
 * covers the bounded lifecycle variants (pending, error, empty, truncated,
 * restored-without-details) the real harness cannot easily produce.
 */
import { afterEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import {
  MAX_COMMAND_DISPLAY_CHARS,
  MAX_ERROR_DISPLAY_CHARS,
  TRUNCATION_MARKER,
  truncateText,
} from "../src/background-shell/jobs";
import {
  SHELL_EXPANDED_RESULT_RENDERERS,
  parseShellLogText,
  renderShellListResult,
  renderShellLogResult,
  renderShellSendResult,
  renderShellStartResult,
  renderShellStopResult,
  shellCollapsedResultRenderer,
  shellExpandedRenderer,
  shellResultDetails,
  visibleCells,
  wrapToWidth,
  type ShellResultViewTheme,
} from "../src/background-shell/result-view";

const theme: ShellResultViewTheme = {
  bold: (text) => `!b${text}!`,
  fg: (_color, text) => text,
};

const renderLines = (
  renderer: (result: unknown, options: unknown, theme: ShellResultViewTheme) => unknown,
  result: unknown,
  width = 200,
): string[] =>
  (renderer(result, { expanded: true }, theme) as { render(w: number): string[] }).render(width) as string[];

const textOf = (r: any) => r.content[0].text as string;

/** Independent ground-truth cell counter for the emoji regression below —
 *  deliberately NOT the production visibleCells. ⏰ U+23F0 and ✅ U+2705
 *  have default emoji presentation (Unicode Emoji_Presentation=Yes): two
 *  terminal cells each, a fact about those code points, not about the
 *  implementation under test. Everything else this fixture can render is
 *  known-narrow; anything unexpected fails loudly instead of miscounting. */
const NARROW_FIXTURE_CP = new Set([0xb7 /* · */, 0x2013 /* – */]);
function measuredCells(line: string): number {
  let cells = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x23f0 || cp === 0x2705) cells += 2;
    else if (cp < 0x7f || NARROW_FIXTURE_CP.has(cp)) cells += 1;
    else throw new Error(`fixture assumption broken: U+${cp.toString(16).toUpperCase()}`);
  }
  return cells;
}

// ── Real-process coverage: production results → production renderers ────

interface Harness {
  tools: Record<string, any>;
  call(name: string, params: any): Promise<any>;
}

function wire(): Harness {
  const tools: Record<string, any> = {};
  registerBackgroundShell({
    registerTool: (t: any) => { tools[t.name] = t; },
    on: () => ({}),
    sendMessage: () => ({}),
  } as any);
  const ctx = { hasUI: false, ui: {} };
  return {
    tools,
    call: (name, params) => tools[name].execute("id", params, undefined, undefined, ctx),
  };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return await fn();
}

afterEach(() => {
  reapAll();
});

describe("real Shell results through the production expanded renderers", () => {
  it("ShellStart result details carry the command, pid, and wake summary, and the expanded view shows them", async () => {
    const { call } = wire();
    const result = await call("ShellStart", {
      command: "sleep 60",
      label: "view",
      wake_on: { match: "Traceback", silence: "10m" },
    });
    const details = result.details;
    expect(details.kind).toBe("pi-review-bg-shell");
    expect(details.tool).toBe("ShellStart");
    expect(details.command).toBe("sleep 60");
    expect(details.label).toBe("view");
    expect(typeof details.pid).toBe("number");
    expect(details.processGroupId).toBe(details.pid);
    expect(details.watching).toContain("exit");
    expect(details.watching).toContain("Traceback");
    expect(details.watching).toContain("silence 10m00s");
    expect(typeof details.startedAt).toBe("number");
    // The model-visible text is unchanged by details enrichment.
    expect(textOf(result)).toContain('Started "view"');
    expect(textOf(result)).toContain('match "Traceback", silence 10m');

    const lines = renderLines(renderShellStartResult as any, result);
    const joined = lines.join("\n");
    expect(joined).toContain("ShellStart · ");
    expect(joined).toContain('!b"view"!');
    expect(joined).toContain("command: sleep 60");
    expect(joined).toContain(`pid ${details.pid}`);
    expect(joined).toContain("watching: exit, match \"Traceback\", silence 10m");
    expect(joined).toContain("started 20");
  });

  it("ShellLog result details carry the range provenance and the expanded view shows the retained lines verbatim", async () => {
    const { call } = wire();
    await call("ShellStart", { command: "echo alpha; echo beta; exit 7", label: "logview" });
    // Wait for the job to exit so the log has its full content, then page it.
    let logResult: any;
    expect(
      await until(async () => {
        const list = await call("ShellList", {});
        logResult = await call("ShellLog", { id: /job\d+/.exec(textOf(list))![0] });
        return textOf(logResult).includes("beta");
      }),
    ).toBe(true);
    const details = logResult.details;
    expect(details.tool).toBe("ShellLog");
    expect(details.status).toBe("failed(7)");
    expect(details.exitCode).toBe(7);
    expect(details.totalLines).toBe(2);
    expect(details.from).toBe(0);
    expect(details.nextOffset).toBe(2);

    const lines = renderLines(renderShellLogResult as any, logResult);
    const joined = lines.join("\n");
    expect(joined).toContain("ShellLog · ");
    expect(joined).toContain('!b"logview"! · failed(7)');
    expect(joined).toContain("lines 0–2 of 2 line(s)");
    expect(joined).toContain("2 line(s), retained output as delivered to the model");
    expect(joined).toContain("alpha");
    expect(joined).toContain("beta");
  });

  it("registered ShellLog keeps repeated ⏰/✅ within width80 and survives narrow rows", async () => {
    const h = wire();
    // One 480-cell line (120 × "⏰✅") and one 90-cell line (45 × "⏰"): both
    // glyphs have default emoji presentation, so each occupies two cells.
    await h.call("ShellStart", {
      command: `printf '⏰✅%.0s' $(seq 120); echo; printf '⏰%.0s' $(seq 45); echo`,
      label: "emoji",
    });
    let logResult: any;
    // Wait until BOTH output lines are retained (120 + 45 = 165 ⏰).
    expect(
      await until(async () => {
        const list = await h.call("ShellList", {});
        logResult = await h.call("ShellLog", { id: /job\d+/.exec(textOf(list))![0] });
        return textOf(logResult).split("⏰").length - 1 >= 165;
      }),
    ).toBe(true);
    // The registered entrypoint is the expandableResult wrapper on the tool.
    const renderRegistered = (options: { expanded: boolean }, width: number): string[] =>
      (h.tools["ShellLog"].renderResult as any)(logResult, options, theme).render(width) as string[];

    for (const options of [{ expanded: false }, { expanded: true }]) {
      for (const line of renderRegistered(options, 80)) {
        expect(measuredCells(line)).toBeLessThanOrEqual(80);
      }
    }
    // Expansion preserves the full retained text across the wrap.
    const expanded = renderRegistered({ expanded: true }, 80).join("\n");
    expect(expanded.split("⏰").length - 1).toBe(165);
    expect(expanded.split("✅").length - 1).toBe(120);
    // Collapsed stays a bounded preview of the wrapped rows: header + fence
    // + ceil(480/78)=7 + ceil(90/78)=2 + fence = 12 rows → 10 + one hint row.
    const collapsed = renderRegistered({ expanded: false }, 80);
    expect(collapsed.length).toBe(11);
    expect(collapsed[collapsed.length - 1]).toContain("more lines");
    expect(collapsed[collapsed.length - 1]).toContain("to expand");
    // Narrow rows: at render width 3 a single emoji is wider than the row —
    // no over-width line may be emitted; at 4 each emoji fills its row
    // exactly and the retained text survives intact.
    for (const width of [3, 4]) {
      for (const line of renderRegistered({ expanded: true }, width)) {
        expect(measuredCells(line)).toBeLessThanOrEqual(width);
      }
    }
    expect(renderRegistered({ expanded: true }, 4).join("\n").split("⏰").length - 1).toBe(165);
  });

  it("registered ShellLog terminates on escape-heavy output and stays width-safe", { timeout: 15000 }, async () => {
    const h = wire();
    // Standalone ESC, an unsupported two-byte escape (ESC(B), and OSC/DCS
    // terminated by ST (ESC backslash): none may stall the tokenizer — a
    // hang fails this test via its timeout instead of freezing the host.
    await h.call("ShellStart", {
      command: `printf 'a\\033b\\033(Bc\\033]0;titled\\033\\\\e\\033Pdcsh\\033\\\\f\\n'`,
      label: "escapes",
    });
    let logResult: any;
    expect(
      await until(async () => {
        const list = await h.call("ShellList", {});
        logResult = await h.call("ShellLog", { id: /job\d+/.exec(textOf(list))![0] });
        return textOf(logResult).includes("titled") && textOf(logResult).includes("dcsh");
      }),
    ).toBe(true);
    const renderRegistered = (options: { expanded: boolean }, width: number): string[] =>
      (h.tools["ShellLog"].renderResult as any)(logResult, options, theme).render(width) as string[];
    for (const options of [{ expanded: false }, { expanded: true }]) {
      for (const line of renderRegistered(options, 80)) {
        expect(measuredCells(line)).toBeLessThanOrEqual(80);
      }
    }
    // Every visible character survives the escape sequences.
    const joined = renderRegistered({ expanded: true }, 80).join("\n");
    for (const ch of ["a", "b", "c", "e", "f"]) expect(joined).toContain(ch);
  });

  it("ShellList result details describe every job and the expanded view renders each row bounded", async () => {
    const { call } = wire();
    const empty = await call("ShellList", {});
    expect(empty.details.tool).toBe("ShellList");
    expect(empty.details.jobs).toEqual([]);
    expect(renderLines(renderShellListResult as any, empty).join("\n")).toContain("no background jobs");

    const started = await call("ShellStart", { command: "sleep 60", label: "listed" });
    const listed = await call("ShellList", {});
    const job = listed.details.jobs[0];
    expect(listed.details.jobs.length).toBe(1);
    expect(job.id).toBe(started.details.id);
    expect(job.status).toBe("running");
    expect(job.command).toBe("sleep 60");
    expect(job.totalLines).toBe(0);
    expect(job.watching).toContain("exit");

    const lines = renderLines(renderShellListResult as any, listed);
    const joined = lines.join("\n");
    expect(joined).toContain("ShellList · 1 job(s) at the time of the call");
    expect(joined).toContain(`  ${job.id} `);
    expect(joined).toContain("— running");
    expect(joined).toContain("command: sleep 60");
    expect(joined).toContain("watching: exit");
    reapAll();
    const afterReap = await call("ShellList", {});
    // reapAll() empties the job map: the collapsed list resets and a later
    // expanded view would show the empty snapshot.
    expect(afterReap.details.jobs.length).toBe(0);
  });

  it("ShellStop results carry the resolved target and the expanded view explains the signal path", async () => {
    const { call } = wire();
    const started = await call("ShellStart", { command: "sleep 60", label: "stoppable" });
    const stopped = await call("ShellStop", { id: started.details.id });
    expect(stopped.details.tool).toBe("ShellStop");
    expect(stopped.details.outcome).toBe("stopping");
    expect(stopped.details.jobId).toBe(started.details.id);
    expect(stopped.details.label).toBe("stoppable");

    const lines = renderLines(renderShellStopResult as any, stopped);
    const joined = lines.join("\n");
    expect(joined).toContain(`ShellStop · ${started.details.id} !b"stoppable"! · stopping`);
    expect(joined).toContain("SIGTERM sent to the process group; SIGKILL escalation follows if it ignores that");
    expect(joined).toContain('Stopping ' + started.details.id);
  });

  it("ShellSend results carry delivery provenance and the expanded view separates confirmed from unconfirmed", async () => {
    const { call } = wire();
    const started = await call("ShellStart", { command: "cat", label: "piper" });
    const sent = await call("ShellSend", { id: started.details.id, text: "hello" });
    expect(sent.details.tool).toBe("ShellSend");
    expect(sent.details.delivery).toBe("confirmed");
    expect(sent.details.bytes).toBe(6);
    const lines = renderLines(renderShellSendResult as any, sent);
    const joined = lines.join("\n");
    expect(joined).toContain("ShellSend · ");
    expect(joined).toContain("confirmed");
    expect(joined).toContain("6 byte(s) written to stdin");
    reapAll();
  });
});

// ── Crafted coverage: bounded lifecycle variants ────────────────────────
describe("parseShellLogText", () => {
  it("extracts the header and body from the retained fenced block", () => {
    const parsed = parseShellLogText('job1 "x" done · 2 lines total\n```\nline one\nline two\n```');
    expect(parsed!.header).toBe('job1 "x" done · 2 lines total');
    expect(parsed!.body).toEqual(["line one", "line two"]);
    expect(parsed!.tailCut).toBe(false);
  });

  it("keeps a log line that is itself a fence when the envelope is intact", () => {
    const parsed = parseShellLogText("header\n```\nalpha\n```\nbeta\n```");
    expect(parsed!.body).toEqual(["alpha", "```", "beta"]);
    expect(parsed!.tailCut).toBe(false);
  });

  it("an embedded fence plus a cut tail keeps the whole suffix and reports the cut (combined regression)", () => {
    // The result cap removed the real closing fence; a naive lastIndexOf
    // would treat the embedded fence as the closer and drop everything after
    // it, hiding retained output and lying about truncation provenance.
    const text = "header\n```\nalpha\n```\nbeta tail" + TRUNCATION_MARKER;
    const parsed = parseShellLogText(text);
    expect(parsed!.tailCut).toBe(true);
    expect(parsed!.body).toEqual(["alpha", "```", `beta tail${TRUNCATION_MARKER}`]);
  });

  it("reports a tail cut when the result cap removed the closing fence", () => {
    const parsed = parseShellLogText("header\n```\nkeep\nlast line" + TRUNCATION_MARKER);
    expect(parsed!.tailCut).toBe(true);
    expect(parsed!.body.length).toBe(2);
    expect(parsed!.body[1]).toContain(TRUNCATION_MARKER);
  });

  it("returns undefined when there is no fenced block", () => {
    expect(parseShellLogText("No background jobs.")).toBeUndefined();
  });
});

describe("bounded lifecycle variants of the production renderers", () => {
  const logContent = (body: string[], header = 'job1 "x" running · 5 lines total') =>
    ({ content: [{ type: "text", text: [header, "```", ...body, "```"].join("\n") }], isError: false });

  it("partial renders are a single bounded pending line for every tool", () => {
    for (const [name, renderer] of Object.entries(SHELL_EXPANDED_RESULT_RENDERERS)) {
      const lines = (renderer(undefined!, { isPartial: true }, theme) as { render(w: number): string[] }).render(80);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(`${name} … (running)`);
      expect(visibleCells(lines[0])).toBeLessThanOrEqual(80);
    }
  });

  it("an untagged result (restored session) falls back to a bounded content preview without fabricating details", () => {
    const legacy = {
      content: [{ type: "text", text: "Started \"old\" as job1 (pid 1); currently running." }],
      isError: false,
    };
    const lines = renderLines(renderShellStartResult as any, legacy) as string[];
    expect(lines[0]).toContain("no structured details were recorded");
    expect(lines.join("\n")).toContain('Started "old" as job1');
    // A details blob with the wrong tool tag is equally untrusted.
    const mismatched = { ...logContent(["one"]), details: { kind: "pi-review-bg-shell", tool: "ShellStop" } };
    expect(renderLines(renderShellLogResult as any, mismatched)[0]).toContain("no structured details");
  });

  it("error results render the bounded error text with no invented details", () => {
    const longError = `Error: ${"x".repeat(400)}`;
    const result = { content: [{ type: "text", text: truncateText(longError, MAX_ERROR_DISPLAY_CHARS) }], isError: true };
    const lines = renderLines(renderShellStartResult as any, {
      ...result,
      details: shellResultDetails("ShellStart"),
    }) as string[];
    expect(lines[0]).toContain("ShellStart · error");
    const joined = lines.join("\n");
    expect(joined).toContain("Error: ");
    expect(joined.includes("x".repeat(240))).toBe(false);
  });

  it("ShellLog shows the empty-range note instead of inventing lines", () => {
    const empty = {
      ...logContent([]),
      details: shellResultDetails("ShellLog", {
        id: "job1",
        label: "x",
        status: "running",
        totalLines: 0,
        droppedLines: 0,
        from: 0,
        nextOffset: 0,
      }),
    };
    const lines = renderLines(renderShellLogResult as any, empty) as string[];
    expect(lines.join("\n")).toContain("(no lines retained in this range)");
  });

  it("ShellLog wraps retained output to terminal cells without losing content", () => {
    const longPlain = "y".repeat(500);
    const ansi = "\x1b[31mred error line\x1b[39m";
    const cjk = "漢字テスト".repeat(30); // 150 wide glyphs = 300 cells
    const tabbed = "col1\tcol2";
    const emoji = "ok 🚀🔥 done";
    const result = {
      ...logContent(["plain line", longPlain, ansi, cjk, tabbed, emoji, "```"]),
      details: shellResultDetails("ShellLog", {
        id: "job1",
        label: "x",
        status: "running",
        totalLines: 7,
        droppedLines: 2,
        from: 2,
        nextOffset: 7,
      }),
    };
    const lines = renderLines(renderShellLogResult as any, result, 200) as string[];
    const joined = lines.join("\n");
    expect(joined).toContain("lines 2–7 of 7 line(s) · 2 oldest dropped from the job buffer");
    expect(joined).toContain("red error line");
    expect(joined).toContain(emoji);
    // At a normal terminal width nothing is cut: the long retained line's
    // suffix remains visible (wrapped), and CJK/emoji count two cells each.
    const eighty = renderLines(renderShellLogResult as any, result, 80) as string[];
    const eightyJoined = eighty.join("\n");
    expect(eightyJoined.split("y").length - 1).toBe(500);
    expect(eightyJoined).toContain(cjk.slice(-4));
    expect(eightyJoined).toContain("col1    col2");
    for (const line of eighty) {
      expect(visibleCells(line)).toBeLessThanOrEqual(80);
    }
    // Narrow widths are respected too (no synthetic 20-column floor).
    const narrow = renderLines(renderShellLogResult as any, result, 12) as string[];
    for (const line of narrow) {
      expect(visibleCells(line)).toBeLessThanOrEqual(12);
    }
    expect(narrow.join("\n").split("y").length - 1).toBe(500);
  });

  it("wraps extended emoji using their actual two-cell width", () => {
    // 🫠 is U+1FAE0, Symbols and Pictographs Extended-A: two terminal cells
    // by an independently known fact, not via the implementation table.
    const payload = "🫠".repeat(80);
    expect(visibleCells(payload)).toBe(160);
    const lines = wrapToWidth(payload, 78);
    expect(lines.join("")).toBe(payload);
    for (const line of lines) {
      expect(Array.from(line).length * 2).toBeLessThanOrEqual(78);
    }
  });

  it("measures default-emoji-presentation ⏰ U+23F0 and ✅ U+2705 as two cells", () => {
    // Both code points have Unicode Emoji_Presentation=Yes: terminals render
    // them as two-cell emoji by default (the review pass 1 regression).
    expect(visibleCells("⏰")).toBe(2);
    expect(visibleCells("✅")).toBe(2);
    expect(visibleCells("a⏰b✅c")).toBe(7);
    expect(visibleCells("⏰✅".repeat(40))).toBe(160);
  });

  it("keeps emoji ZWJ sequences intact and measures them as one two-cell grapheme", () => {
    const family = "👨‍👩‍👧"; // U+1F468 ZWJ U+1F469 ZWJ U+1F467: one emoji, two cells
    expect(visibleCells(family)).toBe(2);
    // 2 + 1 cells fits a 3-cell row without breaking mid-sequence.
    expect(wrapToWidth(`${family}x`, 3)).toEqual([`${family}x`]);
    const wrapped = wrapToWidth(`${family}${family}`, 3);
    for (const line of wrapped) {
      expect(visibleCells(line)).toBeLessThanOrEqual(3);
    }
    expect(wrapped.join("")).toBe(`${family}${family}`);
  });

  it("substitutes a placeholder when one grapheme is wider than the whole row", () => {
    // At width 1 no two-cell emoji can render without exceeding the row.
    expect(wrapToWidth("⏰", 1)).toEqual(["?"]);
    expect(wrapToWidth("a⏰b", 2)).toEqual(["a", "⏰", "b"]);
    for (const line of wrapToWidth("⏰✅".repeat(5), 1)) {
      expect(visibleCells(line)).toBeLessThanOrEqual(1);
    }
  });

  it("wrapToWidth reflows wide glyphs and ANSI styles without losing characters", () => {
    const styled = `\x1b[31m${"红".repeat(10)}\x1b[39m tail`;
    const wrapped = wrapToWidth(styled, 9);
    for (const line of wrapped) {
      expect(visibleCells(line)).toBeLessThanOrEqual(9);
    }
    // The whole payload survives: every wide glyph and the tail are present.
    const joined = wrapped.join("");
    expect(joined.split("红").length - 1).toBe(10);
    expect(joined).toContain("tail");
    // Styles are re-applied at continuation lines (Pi resets at line ends).
    const continuation = wrapped[1]!;
    expect(continuation.startsWith("\x1b[31m")).toBe(true);
    expect(continuation.endsWith("\x1b[0m") || continuation.includes("\x1b[39m")).toBe(true);
    // CR is stripped and tabs are expanded for measurable display only.
    expect(wrapToWidth("a\rb\tc", 40)).toEqual(["ab    c"]);
  });

  it("terminates on every escape shape and matches the host guard's stripping", { timeout: 5000 }, () => {
    // The walk must terminate on every escape shape — a hang fails this test
    // via its timeout instead of freezing rendering. Measurement mirrors
    // pi-tui's extractAnsiCode: only CSI ending in [mGKHJ] and BEL/ST-
    // terminated OSC/APC are stripped; everything else is visible text.
    const body = "a\x1bb\x1b(Bc\x1b]0;titled\x1b\\e\x1bPdcsh\x1b\\f";
    // Stripped: the ST-terminated OSC. Visible: a b ( B c e P d c s h \ f.
    expect(visibleCells(body)).toBe(13);
    expect(wrapToWidth(body, 80)).toEqual([body]);
    // Standalone ESC measures zero cells; the following byte is text.
    expect(visibleCells("a\x1bb")).toBe(2);
    // Unsupported two-byte escape: both bytes are visible text.
    expect(visibleCells("a\x1b(Bc")).toBe(4);
    // OSC terminated by ST (ESC backslash) is stripped.
    const oscSt = "\x1b]0;title\x1b\\ok";
    expect(visibleCells(oscSt)).toBe(2);
    expect(wrapToWidth(oscSt, 2)).toEqual([oscSt]);
    // Malformed CSI: the guard consumes through the first [mGKHJ] byte.
    expect(visibleCells("\x1b[9incomplete")).toBe(5); // "plete" remains
    // CSI with a final byte outside [mGKHJ]: nothing is stripped — the
    // "[?25h" bytes are all visible text (five cells).
    expect(visibleCells("\x1b[?25h")).toBe(5);
    // Unterminated OSC at end of line: payload is visible text, no stall.
    expect(visibleCells("ab\x1b]0;never-terminated")).toBe(21);
    expect(wrapToWidth("ab\x1b]0;never-terminated", 40)).toEqual(["ab\x1b]0;never-terminated"]);
    // Wrapping across escape boundaries stays width-safe and terminates.
    const mixed = `aaaa\x1b]0;t\x1b\\${"红".repeat(20)}\x1b[31m${"x".repeat(50)}\x1b[39m`;
    for (const line of wrapToWidth(mixed, 12)) {
      expect(visibleCells(line)).toBeLessThanOrEqual(12);
    }
  });

  it("ShellLog bounds pathological bodies with a visible note", () => {
    const body = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const result = {
      ...logContent(body),
      details: shellResultDetails("ShellLog", {
        id: "job1",
        label: "x",
        status: "running",
        totalLines: 1000,
        droppedLines: 0,
        from: 0,
        nextOffset: 1000,
      }),
    };
    const lines = renderLines(renderShellLogResult as any, result) as string[];
    expect(lines.join("\n")).toContain("600 more retained line(s)");
  });

  it("ShellLog marks a body cut by the result cap", () => {
    const text = truncateText(
      ['job1 "x" running', "```", "a".repeat(200), "b".repeat(200), "c".repeat(200), "```"].join("\n"),
      120,
    );
    const result = {
      content: [{ type: "text", text }],
      isError: false,
      details: shellResultDetails("ShellLog", {
        id: "job1",
        label: "x",
        status: "running",
        totalLines: 3,
        droppedLines: 0,
        from: 0,
        nextOffset: 3,
      }),
    };
    const lines = renderLines(renderShellLogResult as any, result) as string[];
    expect(lines.join("\n")).toContain("cut by the ShellLog result cap");
  });

  it("ShellSend distinguishes unconfirmed delivery and keeps the bounded byte count", () => {
    const unconfirmed = {
      content: [{ type: "text", text: "Queued 512 bytes to job1 stdin, but delivery was NOT confirmed within 1.5s." }],
      isError: false,
      details: shellResultDetails("ShellSend", {
        event: "stdin-write-unconfirmed",
        id: "job1",
        bytes: 512,
        delivery: "unconfirmed",
      }),
    };
    const lines = renderLines(renderShellSendResult as any, unconfirmed) as string[];
    const joined = lines.join("\n");
    expect(joined).toContain("ShellSend · job1 · unconfirmed");
    expect(joined).toContain("512 byte(s) queued — delivery NOT confirmed within the flush window");
  });

  it("ShellStop renders the all-jobs and already-exited variants from details only", () => {
    const all = {
      content: [{ type: "text", text: "Stopping 3 job(s)." }],
      isError: false,
      details: shellResultDetails("ShellStop", { target: "all", count: 3, outcome: "stopping" }),
    };
    expect(renderLines(renderShellStopResult as any, all).join("\n")).toContain("ShellStop · all jobs · stopping 3 job(s)");

    const exited = {
      content: [{ type: "text", text: 'Job job1 had already exited (failed(2)).' }],
      isError: false,
      details: shellResultDetails("ShellStop", {
        target: "job1",
        jobId: "job1",
        label: "done",
        status: "failed(2)",
        outcome: "already-exited",
      }),
    };
    const joined = renderLines(renderShellStopResult as any, exited).join("\n");
    expect(joined).toContain("already exited (failed(2))");
    expect(joined).not.toContain("SIGTERM sent");
  });

  it("ShellList bounds job rows defensively against oversized details", () => {
    const jobs = Array.from({ length: 20 }, (_, i) => ({
      id: `job${i}`,
      label: `j${i}`,
      status: "running",
      command: "sleep 1",
      watching: "exit",
      totalLines: 1,
      droppedCount: 0,
      elapsedMs: 1000,
      lastOutputAgoMs: null,
    }));
    const result = {
      content: [{ type: "text", text: jobs.map((j) => j.id).join("\n") }],
      isError: false,
      details: shellResultDetails("ShellList", { jobs }),
    };
    const lines = renderLines(renderShellListResult as any, result) as string[];
    expect(lines.join("\n")).toContain("… 4 more job(s)");
  });

  it("ShellStart bounds multiline commands with a visible note", () => {
    const command = Array.from({ length: 8 }, (_, i) => `cmd ${i}`).join("\n");
    const result = {
      content: [{ type: "text", text: 'Started "m" as job1 (pid 1); currently running.' }],
      isError: false,
      details: shellResultDetails("ShellStart", {
        id: "job1",
        label: "m",
        command: truncateText(command, MAX_COMMAND_DISPLAY_CHARS),
        pid: 1,
        watching: "exit",
        startedAt: Date.UTC(2026, 0, 1),
      }),
    };
    const lines = renderLines(renderShellStartResult as any, result) as string[];
    const joined = lines.join("\n");
    expect(joined).toContain("command: cmd 0");
    expect(joined).toContain("4 more command line(s)");
    expect(joined).toContain("started 2026-01-01T00:00:00.000Z");
  });

  it("shellExpandedRenderer selects the production callback by tool name", () => {
    const renderers = SHELL_EXPANDED_RESULT_RENDERERS as Record<string, (r: unknown, o: unknown, t: ShellResultViewTheme) => unknown>;
    for (const [name, renderer] of Object.entries(renderers)) {
      expect(shellExpandedRenderer(name as any)).toBe(renderer);
    }
  });

  it("shellResultDetails tags every result consistently", () => {
    expect(shellResultDetails("ShellLog", { id: "job1" })).toEqual({
      kind: "pi-review-bg-shell",
      tool: "ShellLog",
      id: "job1",
    });
  });
});

describe("shellCollapsedResultRenderer preserves Pi's native fallback", () => {
  const themed: ShellResultViewTheme = {
    bold: (text) => text,
    fg: (color, text) => `[${color}]${text}`,
  };
  const renderCollapsed = (result: unknown, options: unknown, width = 200): string[] =>
    (shellCollapsedResultRenderer(result, options, themed) as { render(w: number): string[] }).render(width);

  const manyLines = Array.from({ length: 25 }, (_, i) => `output line ${i}`);
  const result = { content: [{ type: "text", text: manyLines.join("\n") }], isError: false };

  it("collapsed shows the first ten lines plus the expand hint, colored like the native fallback", () => {
    const lines = renderCollapsed(result, { expanded: false });
    expect(lines.length).toBe(11);
    expect(lines[0]).toBe("[toolOutput]output line 0");
    expect(lines[9]).toBe("[toolOutput]output line 9");
    expect(lines[10]).toContain("[muted]... (15 more lines, ");
    expect(lines[10]).toContain("to expand");
  });

  it("expanded shows the full text, matching the native fallback the wrapper degrades to", () => {
    const lines = renderCollapsed(result, { expanded: true });
    expect(lines.length).toBe(25);
    expect(lines[24]).toBe("[toolOutput]output line 24");
    expect(lines.join("\n")).not.toContain("more lines,");
  });

  it("empty content renders nothing, as the native fallback does", () => {
    expect(renderCollapsed({ content: [{ type: "text", text: "" }] }, {})).toEqual([]);
    expect(renderCollapsed(undefined, {})).toEqual([]);
  });

  it("collapsed is a bounded preview of wrapped rows; expansion recovers every character", () => {
    const wide = { content: [{ type: "text", text: "z".repeat(500) }] };
    // One 500-char line wraps to 14 display rows at this width — the
    // collapsed view must stay a bounded preview, not render all of them.
    const collapsed = renderCollapsed(wide, { expanded: false }, 40);
    for (const line of collapsed) {
      expect(visibleCells(line)).toBeLessThanOrEqual(40);
    }
    expect(collapsed.length).toBeLessThanOrEqual(12);
    expect(collapsed[collapsed.length - 1]).toContain("more lines");
    // Expansion recovers the whole line, wrapped and width-safe.
    const expanded = renderCollapsed(wide, { expanded: true }, 40);
    for (const line of expanded) {
      expect(visibleCells(line)).toBeLessThanOrEqual(40);
    }
    expect(expanded.join("").split("z").length - 1).toBe(500);
    // CJK glyphs count two terminal cells.
    const cjk = { content: [{ type: "text", text: "漢".repeat(100) }] };
    for (const line of renderCollapsed(cjk, { expanded: false }, 30)) {
      expect(visibleCells(line)).toBeLessThanOrEqual(30);
    }
    expect(renderCollapsed(cjk, { expanded: false }, 30).join("").split("漢").length - 1).toBe(100);
  });

  it("collapsed budgets wrapped physical rows for max-length log lines; re-collapse is identical", () => {
    // Three max-length (2048-char) log lines: ten LOGICAL lines would wrap to
    // far more than ten display rows, so the budget must count wrapped rows.
    const body = ["q".repeat(2048), "z".repeat(2048), "r".repeat(2048)];
    const result = {
      content: [{ type: "text", text: ['job1 "x" done', "```", ...body, "```"].join("\n") }],
      isError: false,
    };
    const width = 80; // the component renders at width - 2 inside
    const inner = width - 2;
    // Independent row arithmetic for this ASCII fixture: each logical line is
    // themed with a 12-char prefix before wrapping, then fills rows of `inner`.
    const rowsOf = (s: string) => Math.ceil((`[toolOutput]${s}`.length) / inner);
    const totalRows =
      rowsOf('job1 "x" done') + rowsOf("```") + body.reduce((sum, l) => sum + rowsOf(l), 0) + rowsOf("```");
    expect(totalRows).toBe(84); // 1 + 1 + 27 + 27 + 27 + 1

    const collapsed = renderCollapsed(result, { expanded: false }, width);
    for (const line of collapsed) {
      expect(visibleCells(line)).toBeLessThanOrEqual(width);
    }
    // Bounded: ten preview rows plus the (wrapped) disclosure, nothing else.
    const omitted = totalRows - 10;
    const hint = `[muted]... (${omitted} more lines, to expand)`;
    expect(collapsed.length).toBe(10 + Math.ceil(hint.length / inner));
    // Truthful omission disclosure: the count is the wrapped remainder.
    expect(collapsed[10]).toBe(hint);
    // Expansion preserves the full retained text.
    const expandedJoined = renderCollapsed(result, { expanded: true }, width).join("");
    for (const ch of ["q", "z", "r"] as const) {
      expect(expandedJoined.split(ch).length - 1).toBe(2048);
    }
    // Re-collapse is deterministic and identically bounded (no I/O, no state).
    expect(renderCollapsed(result, { expanded: false }, width)).toEqual(collapsed);
  });
});