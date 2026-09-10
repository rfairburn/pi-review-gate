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

  it("lines are wrapped, never cut, to the render width — even below 20 columns", () => {
    const wide = { content: [{ type: "text", text: "z".repeat(500) }] };
    const narrowLines = renderCollapsed(wide, { expanded: false }, 40);
    for (const line of narrowLines) {
      expect(visibleCells(line)).toBeLessThanOrEqual(40);
    }
    // The suffix survives the wrap — expansion recovers the whole line.
    expect(narrowLines.join("").split("z").length - 1).toBe(500);
    // CJK glyphs count two terminal cells.
    const cjk = { content: [{ type: "text", text: "漢".repeat(100) }] };
    for (const line of renderCollapsed(cjk, { expanded: false }, 30)) {
      expect(visibleCells(line)).toBeLessThanOrEqual(30);
    }
    expect(renderCollapsed(cjk, { expanded: false }, 30).join("").split("漢").length - 1).toBe(100);
  });
});