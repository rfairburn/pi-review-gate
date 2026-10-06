// The compiled-entry peer loading fix (#92 correction): renderers must resolve
// the running host's peer packages through the established shared host-relative
// loader (src/host-peer-loader.ts) during an async warm, never by a bare
// `require` name at render time — a compiled CommonJS extension entry is loaded
// by native import (pi >= 0.86) whose require() bypasses the loader aliases,
// which was the production failure behind the notification full-text fallback.
//
// These tests build a synthetic host install (a package tree whose package.json
// names @earendil-works/pi-coding-agent, with peer packages resolved from it
// exactly like a real install) and drive the REAL warm functions with NO fake
// host injection through the existing setPiTuiHost/setNativeExpansionHost
// seams — the seams stay clear, so this pins the actual loading path.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  setPiTuiHost,
  setPiTuiHostEntryProvider,
  registerNotificationMessageRenderers,
  NOTIFICATION_MESSAGE_TYPES,
  warmPiTuiHost,
  type MessageRendererCallback,
} from "../src/message-expansion";
import {
  setNativeExpansionHost,
  setNativeExpansionHostEntryProvider,
  warmNativeExpansionHost,
} from "../src/presentation-hints";

/** Every synthetic install created by these tests; removed at suite teardown. */
const installDisposals: Array<() => Promise<void>> = [];
test.after(async () => {
  try { await Promise.all(installDisposals.map((dispose) => dispose())); }
  catch { /* teardown best-effort */ }
});

test.afterEach(async () => {
  // Leave the process-global seams exactly as found: nothing injected for the
  // rest of the suite (each test file is its own process).
  setPiTuiHost(undefined);
  setPiTuiHostEntryProvider(undefined);
  setNativeExpansionHost(undefined);
  setNativeExpansionHostEntryProvider(undefined);
});

interface FakeInstall {
  sandbox: string;
  agentEntry: string;
  dispose: () => Promise<void>;
}

/** A synthetic host install: agent package root with resolvable pi-tui peers. */
async function makeFakeInstall(): Promise<FakeInstall> {
  const sandbox = await mkdtemp(join(tmpdir(), "prg-peer-warm-"));
  const agentDir = join(sandbox, "runtime", "node_modules", "@earendil-works", "pi-coding-agent");
  const tuiDir = join(sandbox, "runtime", "node_modules", "@earendil-works", "pi-tui");
  await mkdir(join(agentDir), { recursive: true });
  await mkdir(join(tuiDir), { recursive: true });
  const agentEntry = join(agentDir, "index.mjs");
  await writeFile(
    join(agentDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", type: "module", main: "index.mjs" }),
  );
  await writeFile(
    agentEntry,
    "export function keyHint(keybinding, description) {\n"
    + `  return \x60(ctrl+o \${description})\x60;\n`
    + "}\n"
    + "export function keyText(keybinding) {\n"
    + "  return \"ctrl+o\";\n"
    + "}\n",
  );
  await writeFile(
    join(tuiDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", type: "module", main: "index.mjs" }),
  );
  await writeFile(
    join(tuiDir, "index.mjs"),
    "export function visibleWidth(line) {\n"
    + "  return line.length;\n"
    + "}\n"
    + "export function wrapTextWithAnsi(text, width) {\n"
    + "  if (typeof text !== \"string\" || text.length === 0) return [\"\"];\n"
    + "  const words = String(text).split(/\\r?\\n/);\n"
    + "  const rows = [];\n"
    + "  for (const word of words) {\n"
    + "    for (let i = 0; i < word.length; i += width) rows.push(word.slice(i, i + width));\n"
    + "  }\n"
    + "  return rows;\n"
    + "}\n"
    + "export class MouseRegion {\n"
    + "  constructor(child, onMouse) { this.child = child; this.onMouse = onMouse; }\n"
    + "  render(width) { return this.child.render(width); }\n"
    + "  invalidate() { this.child.invalidate(); }\n"
    + "}\n",
  );
  return {
    sandbox,
    agentEntry,
    dispose: () => rm(sandbox, { recursive: true, force: true }),
  };
}

function subtaskMessage(): Record<string, unknown> {
  return {
    role: "custom",
    customType: "pi-review-subtask-event",
    content: [
      "In-place task task-fix111a finished in place in /tmp/fixture-ws. Review: passed.",
      "Workspace changes since launch: added fixture-a.txt",
      "Task: task-fix111a · Create fixture-a.txt with lorem ipsum · reported",
      "In-place exec-321 COMPLETE: 1/1 tasks settled in place.",
      "Full report: /tmp/fixture-report-warm.md",
      "",
      "DEEP-SENTINEL-WARM: only-visible-expanded",
    ].join("\n"),
    display: true,
    details: { state: "reported", executionId: "exec-321" },
  };
}

const IDENTITY_THEME = {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
};

test("peer warm resolves a synthetic host so renderers produce compact rows with no injection", async () => {
  const install = await makeFakeInstall();
  installDisposals.push(install.dispose);
  // No setPiTuiHost / setNativeExpansionHost injection anywhere: the warm path
  // is load-bearing here exactly as it is at interactive session setup.
  setPiTuiHostEntryProvider(() => install.agentEntry);
  setNativeExpansionHostEntryProvider(() => install.agentEntry);

  const [tui, native] = await Promise.all([warmPiTuiHost(), warmNativeExpansionHost()]);
  assert.ok(tui?.wrapTextWithAnsi, "the synthetic pi-tui peer resolved through the shared loader");
  assert.ok(native?.keyHint && native?.keyText, "the synthetic agent peer resolved keyHint/keyText");

  const registered = new Map<string, MessageRendererCallback>();
  assert.equal(
    registerNotificationMessageRenderers({ registerMessageRenderer: (type: string, cb: MessageRendererCallback) => { registered.set(type, cb); } }),
    true,
  );
  for (const customType of NOTIFICATION_MESSAGE_TYPES) {
    assert.ok(registered.get(customType), `a renderer was registered for ${customType}`);
  }
  const renderer = registered.get("pi-review-subtask-event")!;
  // Collapsed: a custom component (NOT undefined — the compiled-launch bug made
  // this exact call return undefined), with the compact header and hint.
  const collapsed = renderer(subtaskMessage(), { expanded: false, outputPad: 0 }, IDENTITY_THEME);
  assert.ok(collapsed && typeof (collapsed as { render?: unknown }).render === "function",
    "renderer must return a component once the peer is warm");
  const lines = (collapsed as { render(width: number): string[] }).render(120);
  assert.ok(lines.join("\n").includes("[subtask] Create fixture-a.txt with lorem ipsum"), "compact header");
  assert.ok(lines.join("\n").includes("(ctrl+o to expand)"), "configured hint through the warm host");
  assert.ok(!lines.join("\n").includes("DEEP-SENTINEL-WARM"), "collapsed hides the deep body");
  // Expanded: the complete retained text.
  const expanded = renderer(subtaskMessage(), { expanded: true, outputPad: 0 }, IDENTITY_THEME);
  const expandedLines = (expanded as { render(width: number): string[] }).render(120).join("\n");
  assert.ok(expandedLines.includes("DEEP-SENTINEL-WARM"), "expanded shows the full retained text");
});

test("unresolvable entry stays an honest fallback: renderer returns undefined, no throw", async () => {
  const sandbox = await mkdtemp(join(tmpdir(), "prg-peer-warm-empty-"));
  try {
    // A non-host process entry (no package.json naming the agent anywhere up
    // the tree): resolution must find nothing and the renderer must degrade to
    // the documented native fallback, not fabricate a component or throw.
    setPiTuiHostEntryProvider(() => join(sandbox, "not-a-host", "entry.js"));
    setNativeExpansionHostEntryProvider(() => join(sandbox, "not-a-host", "entry.js"));
    const [tui, native] = await Promise.all([warmPiTuiHost(), warmNativeExpansionHost()]);
    assert.equal(tui, undefined, "no pi-tui record exists outside a host process");
    assert.equal(native, undefined, "no agent record exists outside a host process");
    const registered = new Map<string, MessageRendererCallback>();
    registerNotificationMessageRenderers({ registerMessageRenderer: (type: string, cb: MessageRendererCallback) => { registered.set(type, cb); } });
    const renderer = registered.get("pi-review-subtask-event")!;
    const result = renderer(subtaskMessage(), { expanded: false, outputPad: 0 }, IDENTITY_THEME);
    assert.equal(result, undefined, "renderer returns undefined -> the host's full native fallback");
  } finally {
    setPiTuiHostEntryProvider(undefined);
    setNativeExpansionHostEntryProvider(undefined);
  }
});

test("the test-only override seam still wins over the warm", async () => {
  setPiTuiHost({ wrapTextWithAnsi: (_text, width) => [String(width)] });
  const host = await warmPiTuiHost();
  assert.ok(host?.wrapTextWithAnsi);
  assert.deepEqual(host.wrapTextWithAnsi("x", 7), ["7"], "injected host wins, no loader involvement");
});