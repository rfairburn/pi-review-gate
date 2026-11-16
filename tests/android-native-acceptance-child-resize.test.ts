/**
 * Focused check on the synthetic native CLI child's own PTY behaviour.
 *
 * The device acceptance run depends on the owned child repainting when its terminal
 * really resizes, so this test proves that claim against the child ITSELF: the real
 * pinned `@lydell/node-pty`, the real program, its real journal, and the bytes it
 * actually writes to its own TTY. Nothing here involves the owner stack, a viewer, or
 * a device — it is the narrow witness that the redraw is child-produced content, which
 * no owner-side observation can supply.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import * as pty from "@lydell/node-pty";

const SPAWN_BOUND_MS = 15_000;

function waitFor(condition: () => boolean, what: string, boundMs = SPAWN_BOUND_MS): Promise<void> {
  const deadline = Date.now() + boundMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test("the owned child repaints its own TTY when the real PTY resizes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "prg-child-resize-"));
  const journalPath = join(root, "claude.journal.jsonl");
  const controlPath = join(root, "claude.control");
  // The child fails closed unless the fixture's own files already exist.
  writeFileSync(journalPath, "");
  writeFileSync(controlPath, "");

  let output = "";
  const child = pty.spawn(
    process.execPath,
    [
      join(process.cwd(), "tests", "android-native-acceptance", "synthetic-native-cli.cjs"),
      "--backend", "claude",
      "--nonce", "childres1",
      "--journal", journalPath,
      "--control", controlPath,
    ],
    { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
  );
  child.onData((chunk) => { output += chunk; });

  // Settlement is observed, never assumed: `kill` only sends a signal, so cleanup waits
  // for the child's own exit event and escalates once, still bounded. The owned
  // directory is deleted only when every assertion passed AND the child is confirmed
  // gone; otherwise the journal and control file are retained and reported.
  let exited = false;
  let verified = false;
  const exit = new Promise<void>((resolve) => {
    child.onExit(() => {
      exited = true;
      resolve();
    });
  });
  const awaitExit = (): Promise<boolean> => new Promise((resolve) => {
    if (exited) return resolve(true);
    const timer = setTimeout(() => resolve(false), SPAWN_BOUND_MS);
    void exit.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  t.after(async () => {
    try {
      if (!exited) child.kill("SIGTERM");
      if (!(await awaitExit())) {
        child.kill("SIGKILL");
        assert.ok(await awaitExit(), "the owned PTY child must confirm exit");
        throw new Error("the owned PTY child did not settle on SIGTERM");
      }
      if (verified) rmSync(root, { recursive: true, force: true });
    } finally {
      if (existsSync(root)) t.diagnostic(`child resize evidence retained at ${root}`);
    }
  });

  await waitFor(() => output.includes("tty=80x24"), "the child's own 80x24 banner on its PTY");
  assert.ok(!output.includes("tty=96x32"), "the resized banner cannot exist before a resize");

  child.resize(96, 32);
  // This is the byte the CHILD writes, not anything a host injected or restated.
  await waitFor(() => output.includes("tty=96x32"), "the child's own redrawn 96x32 banner on its PTY");

  const records = readFileSync(journalPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { event?: string; cols?: number; rows?: number });
  const resize = records.filter((record) => record.event === "tty-resize");
  assert.equal(resize.length, 1, "the child journalled exactly one real terminal resize");
  assert.deepEqual(
    { cols: resize[0]?.cols, rows: resize[0]?.rows },
    { cols: 96, rows: 32 },
    "the child journaled the size its own terminal reported, not an invented one",
  );
  assert.equal(records.filter((record) => record.event === "stdin-received").length, 0, "no PTY input was involved");
  assert.equal(records.filter((record) => record.event === "osc52-emitted").length, 0, "no copy was emitted");
  assert.ok(existsSync(controlPath), "the fixture's control file was left alone");
  verified = true;
});
