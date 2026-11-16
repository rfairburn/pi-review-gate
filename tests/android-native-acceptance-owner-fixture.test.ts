/**
 * Focused startup-failure check for the Android owner fixture.
 *
 * The fixture registers its cleanup lifecycle before it acquires any live resource,
 * so a listener bind or start failure must still close the watcher, broker,
 * manager, and coordinator it did open, confirm its owned children are gone, and
 * copy the children's journals out before anything is deleted. This occupies the
 * listener port on purpose and asserts exactly that.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { startOwnerFixture, type FixtureOptions } from "./android-native-acceptance/owner-fixture";

const CHILD = resolve(
  __dirname,
  "..",
  "..",
  "tests",
  "android-native-acceptance",
  "synthetic-native-cli.cjs",
);

function options(run: string, listenPort: number, rootParent: string): FixtureOptions {
  return {
    run,
    listenHost: "127.0.0.1",
    listenPort,
    backends: ["claude", "codex"],
    childScript: CHILD,
    rootParent,
    marker: null,
    deviceLabel: null,
  };
}

/** Hold one TCP port so the owner listener cannot bind it. */
async function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test("a listener bind failure settles resources and keeps journal evidence", async () => {
  const held = await occupyPort();
  const rootParent = mkdtempSync(join(tmpdir(), "prg-owner-startup-failure-"));
  try {
    const failure = await startOwnerFixture(options("prgstartfail1", held.port, rootParent)).then(
      () => null,
      (error: unknown) => error as Error,
    );
    assert.notEqual(failure, null, "an occupied listener port must reject startup");
    const message = failure?.message ?? "";
    assert.match(message, /the owner fixture failed to start/);
    assert.match(message, /the owner listener did not start/);
    assert.doesNotMatch(
      message,
      /teardown:/,
      `every acquired resource must settle; teardown reported: ${message}`,
    );

    // The failed start preserves the children's witness files before cleanup, and
    // removes the owned root only because settlement was clean.
    const evidence = readdirSync(rootParent).filter((name) => name.startsWith("evidence-prgstartfail1"));
    assert.deepEqual(evidence, ["evidence-prgstartfail1-failed-startup-failed"]);
    assert.deepEqual(
      readdirSync(join(rootParent, evidence[0])).sort(),
      ["claude.control", "claude.journal.jsonl", "codex.control", "codex.journal.jsonl"],
    );
    assert.deepEqual(
      readdirSync(rootParent).filter((name) => name.startsWith("owner-")),
      [],
      "the owned root is removed only after resources settle",
    );
  } finally {
    await held.release();
    rmSync(rootParent, { recursive: true, force: true });
  }
});
