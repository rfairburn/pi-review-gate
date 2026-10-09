import assert from "node:assert/strict";
import test from "node:test";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import { nativeFormFieldIsEmpty, OUTER_RESTORATION_BASELINE } from "./helpers/session-host-native-main-harness";

// Pure fixture-observation predicates only; no SDK, PTY or native runtime proof.
function frame(marker: "> Workspace:" | "> New name:", value: string): string {
  const roster = "  sibling                       │";
  const padding = " ".repeat(marker.length + 1);
  return [
    "Session host",
    `${roster}${marker} ───────────────`,
    `${roster}${padding}${value.padEnd(15)}`,
    `${roster}${padding}───────────────`,
    `${roster}enter submit | escape cancel`,
  ].join("\n");
}

test("native form witness observes empty Editor content below the top border", () => {
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", ""), "> Workspace:"), true);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", ""), "> New name:"), true);
});

test("native form witness rejects retained drafts and wrong field kinds", () => {
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", "/retained/path"), "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", "old caption"), "> New name:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> New name:", ""), "> Workspace:"), false);
});

test("native form witness rejects missing borders/content rather than assuming empty", () => {
  assert.equal(nativeFormFieldIsEmpty("> Workspace: ", "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty(frame("> Workspace:", "").replace(/─/g, " "), "> Workspace:"), false);
  assert.equal(nativeFormFieldIsEmpty("Session host\n> Workspace: ─────\n", "> Workspace:"), false);
});

test("native outer restoration witness survives the actual tiny-pane resize sequence in the primary buffer", async () => {
  assert.ok(Array.from(OUTER_RESTORATION_BASELINE).length <= 24,
    "the complete primary-buffer witness fits the narrowest tested geometry");
  const surface = new TerminalSurface(120, 50);
  try {
    surface.write(`\x1b[2J\x1b[H${OUTER_RESTORATION_BASELINE}`);
    await surface.flush();
    surface.write("\x1b[?1049h");
    await surface.flush();
    for (const [cols, rows] of [[52, 30], [24, 5], [52, 30], [120, 50], [100, 30], [52, 20], [120, 50]]) {
      surface.resize(cols!, rows!);
      await surface.flush();
    }
    surface.write("\x1b[?1049l");
    await surface.flush();
    assert.ok(surface.frame().lines.map(stripGeneratedSgr).join("\n").includes(OUTER_RESTORATION_BASELINE),
      "leaving the alternate buffer preserves the complete real pre-entry primary-buffer witness");
  } finally {
    surface.dispose();
  }
});
