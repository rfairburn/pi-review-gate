/*
 * Result views for the background shell tool family (#58, #93).
 *
 * Every test drives the PRODUCTION renderers in
 * src/background-shell/result-view.ts — no test-local copy of the ideal
 * rendering. The real-process section feeds actual tool results from
 * registerBackgroundShell through the same registered renderers (including
 * the recorded native render context.args); the crafted section covers the
 * bounded lifecycle variants (pending, error, empty, truncated,
 * restored-without-details) the real harness cannot easily produce.
 *
 * #93 canonical examples 1–5 plus the ShellLog collapsed-tail refinement:
 * collapsed cards are structured useful summaries WITHOUT any toggle hint
 * (the shared wrapper owns the configured-key hint centrally); expanded views
 * show the complete actual inputs and retained results — no 512-character,
 * 4-line, or 8-line legacy cuts; secret-shaped model-visible input is
 * rendered verbatim; delivery/stop outcomes stay truthful.
 */
import { afterEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import {
  TRUNCATION_MARKER,
  truncateText,
} from "../src/background-shell/jobs";
import {
  SHELL_COLLAPSED_RESULT_VIEWS,
  SHELL_EXPANDED_RESULT_RENDERERS,
  parseShellLogText,
  renderShellListResult,
  renderShellLogResult,
  renderShellSendResult,
  renderShellStartResult,
  renderShellStopResult,
  shellCollapsedRenderer,
  shellExpandedRenderer,
  shellListCollapsedView,
  shellLogCollapsedView,
  shellSendCollapsedView,
  shellStartCollapsedView,
  shellStopCollapsedView,
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
  renderer: (result: unknown, options: unknown, theme: ShellResultViewTheme, context?: unknown) => unknown,
  result: unknown,
  width = 200,
  context?: unknown,
): string[] =>
  (renderer(result, { expanded: true }, theme, context) as { render(w: number): string[] }).render(width) as string[];

const textOf = (r: any) => r.content[0].text as string;

/** Drive a collapsed view directly (the registered wrapper routes collapsed
 *  state to it; renderLines drives the expanded callback). */
const renderCollapsedLines = (
  renderer: (result: unknown, options: unknown, theme: ShellResultViewTheme, context?: unknown) => unknown,
  result: unknown,
  width = 200,
  context?: unknown,
): string[] =>
  (renderer(result, { expanded: false }, theme, context) as { render(w: number): string[] }).render(width) as string[];

/** Independent ground-truth cell counter for the emoji regression below —
 *  deliberately NOT the production visibleCells. ⏰ U+23F0 and ✅ U+2705
 *  have default emoji presentation (Unicode Emoji_Presentation=Yes): two
 *  terminal cells each, a fact about those code points, not about the
 *  implementation under test. Everything else this fixture can render is
 *  known-narrow; anything unexpected fails loudly instead of miscounting. */
const NARROW_FIXTURE_CP = new Set([0xb7 /* · */, 0x2013 /* – */, 0x2026 /* … */]);
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

/** Render through the REGISTERED entrypoint (the expandableResult wrapper),
 *  optionally passing the native render context (context.args). */
function renderRegistered(
  tool: any,
  result: unknown,
  options: { expanded?: boolean; isPartial?: boolean },
  context?: unknown,
  width = 200,
): string[] {
  return (tool.renderResult(result, options, theme, context) as { render(w: number): string[] }).render(width) as string[];
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

describe("real Shell results through the production registered renderers (#93 canonical)", () => {
  it("ShellStart: collapsed card is the structured summary, expanded card shows the full command and state", async () => {
    const h = wire();
    const result = await h.call("ShellStart", {
      command: "echo alpha; sleep 60",
      label: "view",
      wake_on: { match: "Traceback", silence: "10m" },
    });
    const details = result.details;
    expect(details.kind).toBe("pi-review-bg-shell");
    expect(details.tool).toBe("ShellStart");
    // The retained detail snapshot carries the COMPLETE command (no 512-char
    // cut) and the state at the moment the call returned.
    expect(details.command).toBe("echo alpha; sleep 60");
    expect(details.state).toBe("running");
    expect(details.label).toBe("view");
    expect(typeof details.pid).toBe("number");
    expect(details.processGroupId).toBe(details.pid);
    expect(details.watching).toContain("exit");
    expect(details.watching).toContain("Traceback");
    expect(details.watching).toContain("silence 10m");
    expect(typeof details.startedAt).toBe("number");
    // The model-visible text is unchanged by details enrichment.
    expect(textOf(result)).toContain('Started "view"');

    const collapsed = renderRegistered(h.tools.ShellStart, result, { expanded: false });
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain(`ShellStart · ${details.id} !b"view"! · running`);
    expect(collapsedJoined).toContain("  command:");
    expect(collapsedJoined).toContain("  echo alpha; sleep 60".replace("  echo", "    echo"));
    expect(collapsedJoined).toContain(`  pid ${details.pid} · started 20`);
    expect(collapsedJoined).toContain("  watching: exit, match \"Traceback\", silence 10m");
    // No family-owned toggle hint anywhere: the shared wrapper owns it.
    expect(collapsedJoined).not.toContain("to expand");
    expect(collapsedJoined).not.toContain("ctrl+o");

    const expanded = renderRegistered(h.tools.ShellStart, result, { expanded: true });
    const joined = expanded.join("\n");
    expect(joined).toContain(`ShellStart · ${details.id} !b"view"! · running`);
    expect(joined).toContain("Command:");
    expect(joined).toContain("echo alpha; sleep 60");
    expect(joined).toContain(`PID: ${details.pid}`);
    expect(joined).toContain("Started: 20");
    expect(joined).toContain('Wake rules: exit, match "Traceback", silence 10m');
    expect(joined).toContain("State: running when this call returned");
    expect(joined).not.toContain("to collapse");

    // Expansion is presentation only; re-collapse restores the same card.
    expect(renderRegistered(h.tools.ShellStart, result, { expanded: false })).toEqual(collapsed);
  });

  it("ShellStart expansion shows every command line and every character beyond the legacy 512-char / 4-line cuts", async () => {
    const h = wire();
    const longCommand = Array.from({ length: 8 }, (_, i) => `step-${i}: ${"z".repeat(60)}`).join("\n");
    expect(longCommand.length > 512).toBe(true);
    const result = await h.call("ShellStart", { command: longCommand, label: "long" });
    expect(result.details.command).toBe(longCommand);
    expect(result.details.command.includes(TRUNCATION_MARKER)).toBe(false);

    // Through the registered entrypoint, with the recorded call arguments as
    // the render context — the production path in the host.
    const expanded = renderRegistered(
      h.tools.ShellStart,
      result,
      { expanded: true },
      { args: { command: longCommand, label: "long" } },
    );
    const joined = expanded.join("\n");
    // Every line of the recorded call command survives expansion.
    for (let i = 0; i < 8; i++) expect(joined).toContain(`step-${i}:`);
    // Content past the legacy 512-character cap is visible.
    expect(joined).toContain("step-7:");
    // The collapsed card keeps the truthful 4-line preview with an omission
    // count — a collapsed-only bound.
    const collapsed = renderRegistered(h.tools.ShellStart, result, { expanded: false });
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain("  command:");
    expect(collapsedJoined).toContain("step-0:");
    expect(collapsedJoined).not.toContain("step-7:");
    expect(collapsedJoined).toContain("  … 4 more command line(s)");
    // Collapse → expand → re-collapse is deterministic.
    expect(renderRegistered(h.tools.ShellStart, result, { expanded: false })).toEqual(collapsed);
  });

  it("ShellStart prefers the recorded context.args command over the result-detail command snapshot", () => {
    const fullCommand = `begin\n${"y".repeat(600)}\nend-marker`;
    const crafted = {
      content: [{ type: "text", text: 'Started "pref" as job1 (pid 1); currently running.' }],
      isError: false,
      // A legacy detail snapshot that was truncated at 512 characters.
      details: shellResultDetails("ShellStart", {
        id: "job1",
        label: "pref",
        command: truncateText(fullCommand, 512),
        pid: 1,
        watching: "exit",
        startedAt: Date.UTC(2026, 0, 1),
        state: "running",
      }),
    };
    const expanded = renderLines(renderShellStartResult as any, crafted, 200, { args: { command: fullCommand } });
    const joined = expanded.join("\n");
    // The preferred source is the complete recorded call argument.
    expect(joined).toContain("end-marker");
    expect(joined.split("y").length - 1 >= 600).toBe(true);
    // Without a render context the untruncated detail snapshot is used; a
    // genuinely truncated legacy snapshot says so with its visible marker.
    const legacyExpanded = renderLines(renderShellStartResult as any, crafted);
    expect(legacyExpanded.join("\n")).toContain(TRUNCATION_MARKER);
  });

  it("ShellStart expansion shows secret-shaped model-visible command text without a human-view filter", async () => {
    const h = wire();
    const secretCommand = 'echo "TOKEN=sk-live-abc123 SECRET"; sleep 60';
    const result = await h.call("ShellStart", { command: secretCommand, label: "secret" });
    const expanded = renderRegistered(
      h.tools.ShellStart,
      result,
      { expanded: true },
      { args: { command: secretCommand } },
    );
    expect(expanded.join("\n")).toContain("TOKEN=sk-live-abc123 SECRET");
  });

  it("ShellList: collapsed rows are the structured summary and expansion renders every recorded command completely", async () => {
    const h = wire();
    const empty = await h.call("ShellList", {});
    expect(empty.details.tool).toBe("ShellList");
    expect(empty.details.jobs).toEqual([]);
    const emptyCollapsed = renderRegistered(h.tools.ShellList, empty, { expanded: false });
    expect(emptyCollapsed.join("\n")).toContain("ShellList · 0 jobs");
    expect(emptyCollapsed.join("\n")).toContain("no background jobs");

    const longCommand = Array.from({ length: 6 }, (_, i) => `suite-${i} --run --filter 'case ${"p".repeat(80)}'`).join("\n");
    expect(longCommand.length > 512).toBe(true);
    await h.call("ShellStart", { command: longCommand, label: "tests" });
    await h.call("ShellStart", { command: "sleep 60", label: "server" });
    const listed = await h.call("ShellList", {});
    expect(listed.details.jobs.length).toBe(2);
    // The snapshot carries the complete recorded commands — expansion reads
    // them from the returned snapshot, never via a live lookup on toggle.
    expect(listed.details.jobs[0].command).toBe(longCommand);
    expect(listed.details.jobs[0].command.includes(TRUNCATION_MARKER)).toBe(false);

    const collapsed = renderRegistered(h.tools.ShellList, listed, { expanded: false });
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain("ShellList · 2 jobs");
    expect(collapsedJoined).toContain(`  ${listed.details.jobs[0].id} !b"tests"! · running`);
    expect(collapsedJoined).toContain(`  ${listed.details.jobs[1].id} !b"server"! · running`);
    expect(collapsedJoined).not.toContain("to expand");

    const expanded = renderRegistered(h.tools.ShellList, listed, { expanded: true });
    const joined = expanded.join("\n");
    expect(joined).toContain("ShellList · 2 jobs");
    expect(joined).toContain('Command:\n    suite-0');
    expect(joined).toContain("suite-5"); // every command line, beyond any cut
    expect(joined).toContain("  Command: sleep 60");
    expect(joined).toContain("  State: running");
    expect(joined).toContain("  PID: ");
    expect(joined).toContain("  Retained output: 0 line(s)");
    expect(joined).toContain("  Dropped output: 0 line(s)");
    expect(joined).toContain("  Wake rules: exit");
    expect(joined).toContain("Snapshot: state recorded by this list call");
    reapAll();
    const afterReap = await h.call("ShellList", {});
    // reapAll() empties the job map: the collapsed list resets and a later
    // expanded view would show the empty snapshot.
    expect(afterReap.details.jobs.length).toBe(0);
  });

  it("ShellLog: collapsed previews the LAST returned lines; expansion shows the complete returned range (no fetch)", async () => {
    const h = wire();
    await h.call("ShellStart", {
      command:
        "for i in 1 2 3 4 5 6; do echo HEAD-$i; done; echo TAIL-A; echo TAIL-B; echo TAIL-C; echo TAIL-D; exit 0",
      label: "tailview",
    });
    let logResult: any;
    expect(
      await until(async () => {
        const list = await h.call("ShellList", {});
        logResult = await h.call("ShellLog", { id: /job\d+/.exec(textOf(list))![0] });
        return textOf(logResult).includes("TAIL-D");
      }),
    ).toBe(true);
    const details = logResult.details;
    expect(details.tool).toBe("ShellLog");
    expect(details.status).toBe("done");
    expect(details.exitCode).toBe(0);
    expect(details.totalLines).toBe(10);
    expect(details.from).toBe(0);
    expect(details.nextOffset).toBe(10);
    // The request selectors are retained for the expanded Request block.
    expect(details.requestOffset).toBeNull(); // tail default
    expect(details.requestLimit).toBe(60);

    // Collapsed: range + the LAST lines of the returned range + truthful
    // earlier-lines omission count. No toggle hint.
    const collapsed = renderRegistered(h.tools.ShellLog, logResult, { expanded: false });
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain('ShellLog · ');
    expect(collapsedJoined).toContain('!b"tailview"! · exited 0');
    expect(collapsedJoined).toContain("  Returned lines: 0–10 · dropped: 0");
    expect(collapsedJoined).toContain("TAIL-D");
    expect(collapsedJoined).toContain("TAIL-B");
    expect(collapsedJoined).not.toContain("HEAD-1");
    expect(collapsedJoined).not.toContain("HEAD-4");
    expect(collapsedJoined).toContain("  … 4 earlier returned lines");
    expect(collapsedJoined).not.toContain("to expand");

    // Expanded: the COMPLETE returned range, all ten lines, with formatting.
    const expanded = renderRegistered(h.tools.ShellLog, logResult, { expanded: true });
    const joined = expanded.join("\n");
    expect(joined).toContain("Request:");
    expect(joined).toContain(`  Job: ${details.id}`);
    expect(joined).toContain("  Offset: tail");
    expect(joined).toContain("  Limit: 60");
    expect(joined).toContain("Returned range: [0, 10)");
    expect(joined).toContain("Next offset: 10");
    expect(joined).toContain("Total lines recorded: 10");
    expect(joined).toContain("Oldest lines dropped: 0");
    expect(joined).toContain("Output:");
    for (const marker of ["HEAD-1", "HEAD-2", "HEAD-3", "HEAD-4", "HEAD-5", "HEAD-6", "TAIL-A", "TAIL-B", "TAIL-C", "TAIL-D"]) {
      expect(joined).toContain(marker);
    }
    // Capture merged the streams: no invented stdout/stderr provenance.
    expect(joined.includes("stdout") || joined.includes("stderr")).toBe(false);
    // Expansion performs no fetch; re-collapse is identical.
    expect(renderRegistered(h.tools.ShellLog, logResult, { expanded: false })).toEqual(collapsed);

    // An explicit offset request is recorded and rendered exactly.
    const paged = await h.call("ShellLog", { id: details.id, offset: 0, lines: 3 });
    expect(paged.details.requestOffset).toBe(0);
    expect(paged.details.requestLimit).toBe(3);
    const pagedExpanded = renderRegistered(h.tools.ShellLog, paged, { expanded: true });
    expect(pagedExpanded.join("\n")).toContain("  Offset: 0");
    expect(pagedExpanded.join("\n")).toContain("  Limit: 3");
    expect(pagedExpanded.join("\n")).toContain("Returned range: [0, 3)");
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
    // Collapsed previews the TAIL of the returned range (the 2-row 90-cell
    // line fits the preview budget; the 7-row 480-cell line is disclosed by
    // its truthful earlier-lines omission count, with no toggle hint).
    const collapsed = renderRegistered({ expanded: false }, 80);
    expect(collapsed.length).toBe(5); // title + range + omission + 2 wrapped rows
    expect(collapsed[collapsed.length - 3]).toContain("1 earlier returned line");
    expect(collapsed.join("\n").split("⏰").length - 1).toBe(45);
    expect(collapsed[collapsed.length - 1]).not.toContain("to expand");
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

  it("ShellStop: stop-all retains the actual target list; stopping is never reported as termination", async () => {
    const h = wire();
    await h.call("ShellStart", { command: "sleep 60", label: "t-one" });
    await h.call("ShellStart", { command: "sleep 60", label: "t-two" });
    const stopped = await h.call("ShellStop", { id: "all" });
    expect(stopped.details.tool).toBe("ShellStop");
    expect(stopped.details.outcome).toBe("stopping");
    expect(stopped.details.count).toBe(2);
    // The affected targets are recorded by this call — not re-derived later.
    expect(stopped.details.targets.length).toBe(2);
    expect(stopped.details.targets.map((t: any) => t.label).sort()).toEqual(["t-one", "t-two"]);

    const collapsed = renderRegistered(h.tools.ShellStop, stopped, { expanded: false });
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain("ShellStop · all jobs · stopping 2");
    expect(collapsedJoined).toContain('!b"t-one"!');
    expect(collapsedJoined).toContain('!b"t-two"!');
    expect(collapsedJoined).toContain(", ");
    expect(collapsedJoined).not.toContain("to expand");

    const expanded = renderRegistered(h.tools.ShellStop, stopped, { expanded: true });
    const joined = expanded.join("\n");
    expect(joined).toContain("ShellStop · all jobs");
    expect(joined).toContain("Request: stop all running jobs");
    expect(joined).toContain("Targets:");
    expect(joined).toContain("!b\"t-one\"!");
    expect(joined).toContain("!b\"t-two\"!");
    expect(joined).toContain("Action: SIGTERM requested");
    expect(joined).toContain("Escalation: existing SIGKILL fallback");
    expect(joined).toContain("Result: stopping; process exit is not yet confirmed");
    expect(joined.includes("terminated")).toBe(false);
    expect(joined.includes("exited")).toBe(false);
  });

  it("ShellStop: single-job results carry the resolved target and the truthful stopping result", async () => {
    const h = wire();
    const started = await h.call("ShellStart", { command: "sleep 60", label: "stoppable" });
    const stopped = await h.call("ShellStop", { id: started.details.id });
    expect(stopped.details.tool).toBe("ShellStop");
    expect(stopped.details.outcome).toBe("stopping");
    expect(stopped.details.jobId).toBe(started.details.id);
    expect(stopped.details.label).toBe("stoppable");

    const collapsed = renderRegistered(h.tools.ShellStop, stopped, { expanded: false });
    expect(collapsed.join("\n")).toContain(`ShellStop · ${started.details.id} !b"stoppable"! · stopping`);

    const expanded = renderRegistered(h.tools.ShellStop, stopped, { expanded: true });
    const joined = expanded.join("\n");
    expect(joined).toContain(`ShellStop · ${started.details.id} !b"stoppable"!`);
    expect(joined).toContain(`Request: stop ${started.details.id}`);
    expect(joined).toContain(`Job: ${started.details.id} !b"stoppable"!`);
    expect(joined).toContain("Action: SIGTERM requested");
    expect(joined).toContain("Escalation: existing SIGKILL fallback");
    expect(joined).toContain("Result: stopping; process exit is not yet confirmed");
    reapAll();
  });

  it("ShellSend: pipe acceptance is shown as transport delivery, never as child processing", async () => {
    const h = wire();
    const started = await h.call("ShellStart", { command: "cat", label: "piper" });
    const sent = await h.call("ShellSend", { id: started.details.id, text: "status" });
    expect(sent.details.tool).toBe("ShellSend");
    expect(sent.details.delivery).toBe("confirmed");
    expect(sent.details.bytes).toBe(7);

    const collapsed = renderRegistered(h.tools.ShellSend, sent, { expanded: false }, { args: { id: started.details.id, text: "status" } });
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain(`ShellSend · ${started.details.id} · pipe accepted 7 bytes`);
    expect(collapsedJoined).toContain('  Input: "status\\n"');
    expect(collapsedJoined).not.toContain("to expand");

    const expanded = renderRegistered(
      h.tools.ShellSend,
      sent,
      { expanded: true },
      { args: { id: started.details.id, text: "status" } },
    );
    const joined = expanded.join("\n");
    expect(joined).toContain(`ShellSend · ${started.details.id}`);
    expect(joined).toContain('Input sent: "status\\n"');
    expect(joined).toContain("Bytes: 7");
    expect(joined).toContain("Delivery: accepted by the stdin pipe");
    expect(joined).toContain("Child processing: not established by this acknowledgment");
    expect(
      renderRegistered(h.tools.ShellSend, sent, { expanded: false }, { args: { id: started.details.id, text: "status" } }),
    ).toEqual(collapsed);
    reapAll();
  });

  it("ShellSend expansion shows secret-shaped and multiline sent input completely, unfiltered", async () => {
    const h = wire();
    const started = await h.call("ShellStart", { command: "cat", label: "vault" });
    const secret = "TOKEN=sk-live-abc123 password=hunter2";
    const sent = await h.call("ShellSend", { id: started.details.id, text: secret });
    expect(sent.details.delivery).toBe("confirmed");
    const expanded = renderRegistered(
      h.tools.ShellSend,
      sent,
      { expanded: true },
      { args: { id: started.details.id, text: secret } },
    );
    const joined = expanded.join("\n");
    // The model-visible input reaches the human view verbatim: no additional
    // masking, redaction, omission, or truncation layer.
    expect(joined).toContain(`Input sent: ${JSON.stringify(`${secret}\n`)}`);
    expect(joined).toContain("TOKEN=sk-live-abc123 password=hunter2");
    expect(joined).not.toContain("…");
    // The collapsed card bounds only its own preview; the input is visible.
    const collapsed = renderRegistered(
      h.tools.ShellSend,
      sent,
      { expanded: false },
      { args: { id: started.details.id, text: secret } },
    );
    expect(collapsed.join("\n")).toContain("TOKEN=sk-live-abc123");
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

  it("an untagged result (restored session) discloses the limitation and renders the COMPLETE retained text expanded", () => {
    // Twenty lines: the legacy 8-line fallback cut is gone — expansion must
    // show everything the record retains.
    const body = Array.from({ length: 20 }, (_, i) => `legacy line ${i}`);
    const legacy = {
      content: [{ type: "text", text: body.join("\n") }],
      isError: false,
    };
    const lines = renderLines(renderShellStartResult as any, legacy) as string[];
    expect(lines[0]).toContain("no structured details were recorded");
    for (const line of body) expect(lines.join("\n")).toContain(line);
    // A details blob with the wrong tool tag is equally untrusted.
    const mismatched = { ...logContent(["one"]), details: { kind: "pi-review-bg-shell", tool: "ShellStop" } };
    expect(renderLines(renderShellLogResult as any, mismatched)[0]).toContain("no structured details");
  });

  it("legacy ShellStart/ShellSend records surface the recorded context.args inputs as submitted", () => {
    // A restored record without structured details still carries the original
    // call arguments in the native render context: expansion must not hide
    // them, and must not claim they were executed or accepted.
    const secretCommand = `train --api-key sk-live-restored-9\n${"r".repeat(600)}\nvalidate --strict`;
    const legacyStart = {
      content: [{ type: "text", text: 'Started "old" as job1 (pid 1); currently running.' }],
      isError: false,
    };
    const startExpanded = renderLines(
      renderShellStartResult as any,
      legacyStart,
      200,
      { args: { command: secretCommand } },
    ) as string[];
    const startJoined = startExpanded.join("\n");
    expect(startJoined).toContain("no structured details were recorded");
    expect(startJoined).toContain("Command submitted:");
    expect(startJoined).toContain("train --api-key sk-live-restored-9");
    expect(startJoined).toContain("validate --strict");
    expect(startJoined.split("r").length - 1 >= 600).toBe(true);
    expect(startJoined).toContain('Started "old" as job1');
    // Without a render context there is nothing to surface: no fabrication.
    const bare = renderLines(renderShellStartResult as any, legacyStart) as string[];
    expect(bare.join("\n")).not.toContain("Command submitted:");

    const secretInput = "TOKEN=sk-live-restored-1\n" + "s".repeat(600);
    const legacySend = {
      content: [{ type: "text", text: "Wrote 21 bytes to job1 stdin." }],
      isError: false,
    };
    const sendExpanded = renderLines(
      renderShellSendResult as any,
      legacySend,
      200,
      { args: { id: "job1", text: secretInput } },
    ) as string[];
    const sendJoined = sendExpanded.join("\n");
    expect(sendJoined).toContain("no structured details were recorded");
    expect(sendJoined).toContain("Input submitted:");
    expect(sendJoined).toContain("TOKEN=sk-live-restored-1");
    expect(sendJoined.split("s").length - 1 >= 600).toBe(true);
    expect(sendJoined).toContain("Wrote 21 bytes to job1 stdin.");
    // The submitted label makes no acceptance claim; the retained result
    // speaks for itself.
    expect(sendJoined).not.toContain("accepted by the stdin pipe");
  });

  it("the collapsed legacy preview stays a bounded native-like preview with no toggle hint", () => {
    const body = Array.from({ length: 25 }, (_, i) => `output line ${i}`);
    const legacy = { content: [{ type: "text", text: body.join("\n") }], isError: false };
    const collapsed = renderCollapsedLines(shellListCollapsedView as any, legacy) as string[];
    expect(collapsed.length).toBe(11); // 10 wrapped preview rows + the omission marker
    expect(collapsed[0]).toContain("output line 0");
    expect(collapsed[9]).toContain("output line 9");
    expect(collapsed[10]).toContain("... (15 more lines)");
    expect(collapsed.join("\n")).not.toContain("to expand");
    // Re-collapse is identical (no I/O, no state).
    expect(renderCollapsedLines(shellListCollapsedView as any, legacy) as string[]).toEqual(collapsed);
  });

  it("expanded error results render the complete retained error text and the submitted input", () => {
    // A producer-bounded multiline retained error: expansion shows every line
    // of the record with no presentation cap, plus the complete recorded call
    // input labeled as submitted.
    const retainedError = [
      "Error: could not start job: spawn /bin/bash EAGAIN",
      ...Array.from({ length: 4 }, (_, i) => `  detail line ${i}: ${"d".repeat(60)}`),
      "  at spawn (node:child_process)",
    ].join("\n");
    const secretCommand = `deploy --token sk-live-topsecret-1\n${"c".repeat(600)}\npost-install --verify`;
    const result = {
      content: [{ type: "text", text: retainedError }],
      isError: true,
      details: shellResultDetails("ShellStart"),
    };
    const lines = renderLines(
      renderShellStartResult as any,
      result,
      200,
      { args: { command: secretCommand } },
    ) as string[];
    const joined = lines.join("\n");
    expect(lines[0]).toContain("ShellStart · error");
    // The submitted input is visible in full — including the secret-shaped
    // text and content beyond 512 characters — without an execution claim.
    expect(joined).toContain("Command submitted:");
    expect(joined).toContain("deploy --token sk-live-topsecret-1");
    expect(joined).toContain("post-install --verify");
    expect(joined).not.toContain("Command:");
    expect(joined).not.toContain("State: running");
    // The complete retained error text survives: every line, no cut.
    for (const line of retainedError.split("\n")) expect(joined).toContain(line);
    expect(joined).toContain("at spawn (node:child_process)");
    // Re-collapse is deterministic (the collapsed card keeps its own
    // bounded summary; only expansion changes).
    const collapsed = renderCollapsedLines(shellStartCollapsedView as any, result, 200, { args: { command: secretCommand } }) as string[];
    expect(renderCollapsedLines(shellStartCollapsedView as any, result, 200, { args: { command: secretCommand } }) as string[]).toEqual(collapsed);
  });

  it("ShellSend failures keep the full submitted stdin input visible without delivery claims", async () => {
    const h = wire();
    const id = textOf(await h.call("ShellStart", { command: "exit 0", label: "gone" })).match(/as (job\d+)/)![1];
    expect(await until(async () => textOf(await h.call("ShellList", {})).includes("done"))).toBe(true);
    const secret = "TOKEN=sk-live-abc123\npassword=hunter2\n" + "x".repeat(600);
    const failed = await h.call("ShellSend", { id, text: secret });
    expect(failed.isError).toBe(true);

    // Through the registered entrypoint with the recorded call arguments.
    const expanded = renderRegistered(
      h.tools.ShellSend,
      failed,
      { expanded: true },
      { args: { id, text: secret } },
    );
    const joined = expanded.join("\n");
    // The real failure result is untagged: the legacy expanded view discloses
    // the limitation, then shows the submitted input and the error.
    expect(expanded[0]).toContain("no structured details were recorded");
    expect(joined).toContain("Input submitted:");
    // The secret-shaped, multiline, >512-char input is fully visible.
    expect(joined).toContain("TOKEN=sk-live-abc123");
    expect(joined).toContain("password=hunter2");
    expect(joined.split("x").length - 1 >= 600).toBe(true);
    // The complete retained error text survives, and no delivery is claimed.
    expect(joined).toContain("has already exited");
    expect(joined).not.toContain("accepted by the stdin pipe");
    expect(joined).not.toContain("Child processing:");
    // Re-collapse is identical.
    const collapsed = renderRegistered(h.tools.ShellSend, failed, { expanded: false }, { args: { id, text: secret } });
    expect(renderRegistered(h.tools.ShellSend, failed, { expanded: false }, { args: { id, text: secret } })).toEqual(collapsed);
    reapAll();
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
        requestOffset: null,
        requestLimit: 60,
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
        requestOffset: 2,
        requestLimit: 5,
      }),
    };
    const lines = renderLines(renderShellLogResult as any, result, 200) as string[];
    const joined = lines.join("\n");
    expect(joined).toContain("Returned range: [2, 7)");
    expect(joined).toContain("Oldest lines dropped: 2");
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
        requestOffset: 0,
        requestLimit: 1000,
      }),
    };
    const lines = renderLines(renderShellLogResult as any, result) as string[];
    expect(lines.join("\n")).toContain("600 more retained line(s)");
  });

  it("ShellLog marks a body cut by the result cap and discloses it in both states", () => {
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
        requestOffset: 0,
        requestLimit: 3,
      }),
    };
    const expandedJoined = renderLines(renderShellLogResult as any, result) as string[];
    expect(expandedJoined.join("\n")).toContain("cut by the ShellLog result cap");
    const collapsedJoined = renderCollapsedLines(shellLogCollapsedView as any, result) as string[];
    expect(collapsedJoined.join("\n")).toContain("cut by the ShellLog result cap");
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
    const collapsed = renderCollapsedLines(shellSendCollapsedView as any, unconfirmed) as string[];
    expect(collapsed.join("\n")).toContain("ShellSend · job1 · queued 512 bytes · delivery unconfirmed");
    const lines = renderLines(renderShellSendResult as any, unconfirmed) as string[];
    const joined = lines.join("\n");
    expect(joined).toContain("ShellSend · job1");
    expect(joined).toContain("512");
    expect(joined).toContain("Delivery: queued — delivery NOT confirmed within the flush window");
    expect(joined).toContain("Child processing: not established by this acknowledgment");
    // Without the recorded call arguments or a retained input, the field is
    // disclosed as unavailable, never fabricated.
    expect(joined).toContain("Input sent: unavailable in the recorded result");
  });

  it("ShellStop renders the all-jobs and already-exited variants from details only", () => {
    const all = {
      content: [{ type: "text", text: "Stopping 3 job(s)." }],
      isError: false,
      details: shellResultDetails("ShellStop", {
        target: "all",
        count: 3,
        outcome: "stopping",
        targets: [{ id: "job1", label: "a" }, { id: "job2", label: "b" }, { id: "job3", label: "c" }],
      }),
    };
    const allCollapsed = renderCollapsedLines(shellStopCollapsedView as any, all).join("\n");
    expect(allCollapsed).toContain("ShellStop · all jobs · stopping 3");
    expect(allCollapsed).toContain('!b"a"!, job2 !b"b"!, job3 !b"c"!');
    const allExpanded = renderLines(renderShellStopResult as any, all).join("\n");
    expect(allExpanded).toContain("Request: stop all running jobs");
    expect(allExpanded).toContain("  job1 !b\"a\"!");
    expect(allExpanded).toContain("Result: stopping; process exit is not yet confirmed");

    const exited = {
      content: [{ type: "text", text: "Job job1 had already exited (failed(2))." }],
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
    expect(joined).toContain("Result: job had already exited (failed(2)); no signal was sent by this call");
    expect(joined).not.toContain("SIGTERM");
    const exitedCollapsed = renderCollapsedLines(shellStopCollapsedView as any, exited).join("\n");
    expect(exitedCollapsed).toContain("already exited (failed(2))");
  });

  it("ShellStop discloses unavailable stop-all targets instead of re-deriving them", () => {
    const all = {
      content: [{ type: "text", text: "Stopping 3 job(s)." }],
      isError: false,
      details: shellResultDetails("ShellStop", { target: "all", count: 3, outcome: "stopping" }),
    };
    expect(renderCollapsedLines(shellStopCollapsedView as any, all).join("\n")).toContain("targets: unavailable in the recorded result");
    expect(renderLines(renderShellStopResult as any, all).join("\n")).toContain("Targets: unavailable in the recorded result");
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
    const collapsed = renderCollapsedLines(shellListCollapsedView as any, result) as string[];
    expect(collapsed.join("\n")).toContain("… 4 more job(s)");
  });

  it("ShellStart keeps the 4-line collapsed command preview with a truthful omission count; expansion shows all lines", () => {
    const command = Array.from({ length: 8 }, (_, i) => `cmd ${i}`).join("\n");
    const result = {
      content: [{ type: "text", text: 'Started "m" as job1 (pid 1); currently running.' }],
      isError: false,
      details: shellResultDetails("ShellStart", {
        id: "job1",
        label: "m",
        command,
        pid: 1,
        watching: "exit",
        startedAt: Date.UTC(2026, 0, 1),
        state: "running",
      }),
    };
    const collapsed = renderCollapsedLines(shellStartCollapsedView as any, result) as string[];
    const collapsedJoined = collapsed.join("\n");
    expect(collapsedJoined).toContain("ShellStart · job1 !b\"m\"! · running");
    expect(collapsedJoined).toContain("  command:");
    expect(collapsedJoined).toContain("    cmd 0");
    expect(collapsedJoined).toContain("  … 4 more command line(s)");
    expect(collapsedJoined).not.toContain("cmd 7");
    expect(collapsedJoined).toContain("  pid 1 · started 2026-01-01T00:00:00.000Z");

    const expanded = renderLines(renderShellStartResult as any, result) as string[];
    const expandedJoined = expanded.join("\n");
    for (let i = 0; i < 8; i++) expect(expandedJoined).toContain(`cmd ${i}`);
    expect(expandedJoined).toContain("State: running when this call returned");
  });

  it("shellExpandedRenderer and shellCollapsedRenderer select the production callbacks by tool name", () => {
    const renderers = SHELL_EXPANDED_RESULT_RENDERERS as Record<string, (r: unknown, o: unknown, t: ShellResultViewTheme) => unknown>;
    for (const [name, renderer] of Object.entries(renderers)) {
      expect(shellExpandedRenderer(name as any)).toBe(renderer);
      expect(shellCollapsedRenderer(name as any)).toBe(SHELL_COLLAPSED_RESULT_VIEWS[name as keyof typeof SHELL_COLLAPSED_RESULT_VIEWS]);
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