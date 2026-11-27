/**
 * #795 focused controls for the external native sibling fixture roots.
 *
 * These cases exercise the same receipted root, setup inventory, settlement
 * gate, preserve choice, and refusal path the POSIX source-launcher and native
 * Main row-lifecycle legs register in their own finalizers. They start no
 * child process and are therefore distinct from the real native lanes, which
 * remain their own opt-in platform proof; every root here is outside the
 * checkout and is removed by this control's own finalizer.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertOutsideCheckout,
  captureFixtureInventory,
  captureSetupInventory,
  createSetupFile,
  disposeFixtureRoot,
  fixtureRootReceipt,
  assertPositivelyCreatedDirectory,
  establishPositivelyCreatedDirectory,
  fixtureCreationReceipt,
  preserveRequested,
  refreshFixtureFile,
  recordSetupDirectory,
  retainedFixtureBase,
  type FixtureRootReceipt,
} from "./helpers/scratch-fixture-base";
import { ChangeSignal } from "./helpers/change-signal";
import { OwnedPidExitWatcher, closeAcquiredWatchers, compileAndStageCandidate } from "./helpers/session-host-native-main-harness";
import {
  LegDeadline,
  PosixKernelExitWatcher,
  PosixLauncherPtyDriver,
  createLauncherLegLayout,
  createOwnedDirectory,
  type PosixLauncherRuntimePin,
} from "./helpers/session-host-native-posix-launcher";
import { SavedMainDriver, createSavedMainScratchRoot } from "./helpers/session-host-native-saved-main-harness";
import { boundedJsonl, writeOwnedFile } from "./helpers/session-host-native-windows-harness";

interface ControlRoot {
  readonly path: string;
  readonly receipt: FixtureRootReceipt;
}

// These controls exercise POSIX canonical paths and private-mode receipts; the
// real source-launcher and row-lifecycle lanes keep their own platform gates.
const WINDOWS_SKIP = process.platform === "win32"
  ? "external fixture ownership controls use POSIX canonical paths and private modes"
  : false;
const PYTHON_AVAILABLE = (() => {
  const probe = spawnSync("python3", ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"],
    { encoding: "utf8", timeout: 5_000 });
  return !probe.error && probe.status === 0;
})();
const ROLE_MARKERS_PRESENT = Object.keys(process.env).some((name) => {
  const canonical = name.toUpperCase();
  return canonical === "PI_REVIEW_GATE_RUNTIME_ROLE" || canonical === "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG";
});

function disposalTest(name: string, body: () => void): void {
  test(name, { skip: WINDOWS_SKIP }, body);
}

function createControlRoot(): ControlRoot {
  const path = mkdtempSync(join(retainedFixtureBase(), "prg-disposal-"));
  return { path, receipt: fixtureRootReceipt(path) };
}

function removeControlRoot(root: ControlRoot): void {
  const entry = lstatSync(root.path, { bigint: true, throwIfNoEntry: false });
  assert.ok(entry?.isDirectory() && entry.dev === root.receipt.dev && entry.ino === root.receipt.ino,
    `the control still owns its fixture root: ${root.path}`);
  rmSync(root.path, { recursive: true, force: false });
  assert.equal(existsSync(root.path), false);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

disposalTest("a settled receipted fixture is inventoried before removal and gone afterwards", () => {
  const root = createControlRoot();
  const reports: string[] = [];
  try {
    assert.equal(assertOutsideCheckout(root.path), root.path, "the control root is reported at its external canonical path");
    mkdirSync(join(root.path, "owned-directory"), { mode: 0o700 });
    writeFileSync(join(root.path, "owned-file.txt"), "owned\n", { flag: "wx", mode: 0o600 });
    const inventory = captureFixtureInventory(root.path, root.receipt);
    assert.deepEqual([...inventory.entries.keys()].sort(), ["owned-directory", "owned-file.txt"],
      "the inventory records exactly the entries this fixture's own setup created");

    const outcome = disposeFixtureRoot({
      label: "focused external fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: (line) => reports.push(line),
    });
    assert.deepEqual(outcome, { removed: true, path: root.path });
    assert.equal(existsSync(root.path), false, "the default disposal removes its exact root");
    assert.ok(reports.some((line) => line.includes(root.path)), "removal reports the owned path");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("explicit preservation retains and reports the external path without skipping checks", () => {
  const root = createControlRoot();
  const reports: string[] = [];
  try {
    writeFileSync(join(root.path, "evidence.txt"), "preserved evidence\n", { flag: "wx", mode: 0o600 });
    const inventory = captureFixtureInventory(root.path, root.receipt);
    const outcome = disposeFixtureRoot({
      label: "focused external fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: true,
      report: (line) => reports.push(line),
    });
    assert.deepEqual(outcome, { removed: false, path: root.path });
    assert.equal(existsSync(join(root.path, "evidence.txt")), true, "preservation keeps the fixture evidence");
    assert.ok(reports.some((line) => line.includes(root.path) && line.includes("outside checkout")),
      "the retained path and its external location are reported");

    // Preservation never skips settlement or ownership: the same root is still
    // refused when either gate fails.
    assert.throws(() => disposeFixtureRoot({
      label: "focused external fixture",
      root: root.path,
      receipt: { dev: root.receipt.dev, ino: root.receipt.ino + 1n },
      settled: true,
      preserve: true,
      report: (line) => reports.push(line),
    }), /changed identity or canonical path/);
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("an unconfirmed settlement retains the evidence path and fails visibly", () => {
  const root = createControlRoot();
  try {
    writeFileSync(join(root.path, "unsettled.txt"), "unsettled\n", { flag: "wx", mode: 0o600 });
    const inventory = captureFixtureInventory(root.path, root.receipt);
    assert.throws(() => disposeFixtureRoot({
      label: "focused external fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: false,
      unsettledDetail: "owned child exit was not observed",
      preserve: false,
      report: () => undefined,
    }), (error: unknown) => error instanceof Error
      && error.message.includes("settlement is unconfirmed")
      && error.message.includes(root.path)
      && error.message.includes("owned child exit was not observed"));
    assert.equal(existsSync(join(root.path, "unsettled.txt")), true, "unsettled evidence is not removed");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("an unrecorded or replaced entry refuses removal and keeps the foreign artifact", () => {
  const root = createControlRoot();
  try {
    mkdirSync(join(root.path, "owned-directory"), { mode: 0o700 });
    writeFileSync(join(root.path, "owned-file.txt"), "owned\n", { flag: "wx", mode: 0o600 });
    const inventory = captureFixtureInventory(root.path, root.receipt);
    writeFileSync(join(root.path, "foreign.txt"), "not this fixture's setup\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => disposeFixtureRoot({
      label: "focused external fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    }), /entry setup did not record/);
    assert.equal(existsSync(join(root.path, "foreign.txt")), true, "an unrecorded entry is never traversed or removed");

    // The control owns the foreign probe it just wrote; removing it leaves the
    // recorded inventory honest, and the root still refuses a replaced entry.
    rmSync(join(root.path, "foreign.txt"));
    rmSync(join(root.path, "owned-directory"), { recursive: true, force: false });
    writeFileSync(join(root.path, "owned-directory"), "replacement kind\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => disposeFixtureRoot({
      label: "focused external fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    }), /entry is missing, replaced, or changed/);
    assert.equal(existsSync(root.path), true, "a replaced entry keeps the whole root");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("known partial setup without a spawn attempt is removed, while an unconfirmed spawn retains", () => {
  const partial = createControlRoot();
  try {
    // A setup failure after root creation but before any child spawn leaves
    // only this fixture's synchronous entries; the finalizer can inventory them
    // now and remove the partial tree.
    mkdirSync(join(partial.path, "partial-home"), { mode: 0o700 });
    const inventory = captureFixtureInventory(partial.path, partial.receipt);
    assert.deepEqual([...inventory.entries.keys()], ["partial-home"]);
    disposeFixtureRoot({
      label: "focused partial fixture",
      root: partial.path,
      receipt: partial.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    });
    assert.equal(existsSync(partial.path), false, "the known partial setup is removed");
  } finally {
    if (existsSync(partial.path)) removeControlRoot(partial);
  }

  const unconfirmed = createControlRoot();
  try {
    assert.throws(() => disposeFixtureRoot({
      label: "focused unconfirmed fixture",
      root: unconfirmed.path,
      receipt: unconfirmed.receipt,
      settled: false,
      unsettledDetail: "the spawn was attempted without a returned handle",
      preserve: false,
      report: () => undefined,
    }), /retained evidence at/);
    assert.equal(existsSync(unconfirmed.path), true, "an unconfirmed spawn is not treated as partial setup");
  } finally {
    if (existsSync(unconfirmed.path)) removeControlRoot(unconfirmed);
  }
});

disposalTest("the preserve choice is validated and a checkout-local path is refused", () => {
  const previous = process.env.PI_TEST_SCRATCH_PRESERVE;
  try {
    delete process.env.PI_TEST_SCRATCH_PRESERVE;
    assert.equal(preserveRequested(), false);
    process.env.PI_TEST_SCRATCH_PRESERVE = "0";
    assert.equal(preserveRequested(), false);
    process.env.PI_TEST_SCRATCH_PRESERVE = "1";
    assert.equal(preserveRequested(), true);
    process.env.PI_TEST_SCRATCH_PRESERVE = "true";
    assert.throws(() => preserveRequested(), /must be 1 or 0/);
  } finally {
    if (previous === undefined) delete process.env.PI_TEST_SCRATCH_PRESERVE;
    else process.env.PI_TEST_SCRATCH_PRESERVE = previous;
  }
  assert.throws(() => assertOutsideCheckout(process.cwd()), /must stay outside the checkout/);
});

disposalTest("an unknown entry below a recorded directory refuses removal", () => {
  const root = createControlRoot();
  try {
    mkdirSync(join(root.path, "owned-directory"), { mode: 0o700 });
    const inventory = captureFixtureInventory(root.path, root.receipt);
    writeFileSync(join(root.path, "owned-directory", "foreign.txt"), "foreign\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => disposeFixtureRoot({
      label: "focused nested fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    }), /entry setup did not record/);
    assert.equal(existsSync(join(root.path, "owned-directory", "foreign.txt")), true,
      "a nested entry setup did not record is never adopted by recursive removal");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("only declared producer directories may gain runtime entries", () => {
  const root = createControlRoot();
  try {
    mkdirSync(join(root.path, "producer"), { mode: 0o700 });
    mkdirSync(join(root.path, "strict"), { mode: 0o700 });
    const inventory = captureFixtureInventory(root.path, root.receipt, { mutableDirectories: ["producer"] });
    assert.deepEqual([...inventory.entries.keys()].sort(), ["producer", "strict"]);
    writeFileSync(join(root.path, "producer", "runtime.txt"), "runtime\n", { flag: "wx", mode: 0o600 });
    const outcome = disposeFixtureRoot({
      label: "focused producer fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    });
    assert.equal(outcome.removed, true, "the declared producer tree is removed with its recorded root");
    assert.equal(existsSync(root.path), false);
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a same-kind file replacement is refused unless its known atomic rename refreshed the receipt", () => {
  const root = createControlRoot();
  try {
    const file = join(root.path, "owned-file.txt");
    writeFileSync(file, "original\n", { flag: "wx", mode: 0o600 });
    const inventory = captureFixtureInventory(root.path, root.receipt);
    // Hold the original inode open so the replacement cannot reuse it.
    const held = openSync(file, "r");
    try {
      const replacement = join(root.path, "replacement.txt");
      writeFileSync(replacement, "replacement\n", { flag: "wx", mode: 0o600 });
      renameSync(replacement, file);
    } finally {
      closeSync(held);
    }
    assert.throws(() => disposeFixtureRoot({
      label: "focused replacement fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    }), /file entry is missing, replaced, or changed/);
    assert.equal(existsSync(file), true, "a same-kind replacement is retained without a refreshed receipt");

    const current = lstatSync(file, { bigint: true });
    const refreshed = refreshFixtureFile(inventory, "owned-file.txt", { dev: current.dev, ino: current.ino });
    disposeFixtureRoot({
      label: "focused replacement fixture",
      root: root.path,
      receipt: root.receipt,
      inventory: refreshed,
      settled: true,
      preserve: false,
      report: () => undefined,
    });
    assert.equal(existsSync(root.path), false,
      "the one known parent atomic-rename receipt refresh permits removal");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

test("a pre-spawn start failure removes both exact partial roots and preserves the original error", {
  skip: WINDOWS_SKIP || (ROLE_MARKERS_PRESENT
    ? "delegated role/catalog markers are present; the real launcher allocation guard is exercised by the opt-in lane"
    : false),
}, async () => {
  const previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  let posixRoot: string | undefined;
  let posixReceipt: FixtureRootReceipt | undefined;
  let rowRoot: string | undefined;
  let rowReceipt: FixtureRootReceipt | undefined;
  try {
    const layout = createLauncherLegLayout((root) => {
      posixRoot = root;
      posixReceipt = fixtureRootReceipt(root);
    });
    const rowScratch = createSavedMainScratchRoot((root) => {
      rowRoot = root;
      rowReceipt = fixtureRootReceipt(root);
    });
    assert.ok(posixRoot && posixReceipt && rowRoot && rowReceipt,
      "both roots report their receipt immediately after exclusive creation");
    process.env.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
    let posixSpawnAttempted = false;
    let rowSpawnAttempted = false;
    const deadline = new LegDeadline(5_000);
    try {
      await assert.rejects(async () => {
        PosixLauncherPtyDriver.start({
          runtime: undefined as unknown as PosixLauncherRuntimePin,
          layout,
          nonce: "pre-spawn-fault",
          deadline,
          onSpawnAttempt: () => { posixSpawnAttempted = true; },
        });
      }, /PI_REVIEW_GATE_RUNTIME_ROLE/);
      await assert.rejects(SavedMainDriver.start({
        ptyModule: undefined as never,
        scratchRoot: rowScratch,
        candidate: undefined as never,
        runtime: undefined as never,
        observerFile: join(rowScratch, "observer", "row-lifecycle.jsonl"),
        args: [],
        env: {},
        onSpawnAttempt: () => { rowSpawnAttempted = true; },
      }), /role\/catalog marker/);
    } finally {
      deadline.dispose();
    }
    assert.equal(posixSpawnAttempted, false, "the launcher spawn boundary is never reached on a pre-spawn fault");
    assert.equal(rowSpawnAttempted, false, "the Saved Main spawn boundary is never reached on a pre-spawn fault");
  } finally {
    if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
    for (const [root, receipt] of [[posixRoot, posixReceipt], [rowRoot, rowReceipt]] as const) {
      if (root === undefined || receipt === undefined) continue;
      if (!existsSync(root)) continue;
      // The partial roots are owned because their own creation ledger accounts
      // for every entry, not because a scan happened to find them.
      const inventory = captureSetupInventory(root, receipt);
      disposeFixtureRoot({
        label: "pre-spawn partial fixture",
        root,
        receipt,
        inventory,
        settled: true,
        preserve: false,
        report: () => undefined,
      });
    }
  }
});

disposalTest("an exclusive-creation collision is retained and reported, never adopted for removal", () => {
  const root = createControlRoot();
  try {
    // A foreign entry occupies the name the setup would create exclusively.
    mkdirSync(join(root.path, "home"), { mode: 0o700 });
    let setupError: unknown;
    try {
      createOwnedDirectory(root.path, "home");
    } catch (error) {
      setupError = error;
    }
    assert.match(String(setupError), /EEXIST/, "the setup's exclusive creation failed on the foreign entry");

    let captureError: unknown;
    try {
      captureSetupInventory(root.path, root.receipt, { mutableDirectories: ["home"] });
    } catch (error) {
      captureError = error;
    }
    const detail = captureError instanceof Error ? captureError.message : String(captureError);
    assert.match(detail, /did not positively create/, "the inventory refuses an entry the setup never created");
    assert.ok(detail.includes(join(root.path, "home")) && detail.includes(root.path),
      `the refusal names both the unowned entry and the retained root: ${detail}`);
    assert.throws(() => disposeFixtureRoot({
      label: "collision fixture",
      root: root.path,
      receipt: root.receipt,
      settled: true,
      preserve: false,
      report: () => undefined,
    }), /requires a captured ownership inventory/,
    "without an owned inventory the caller retains the root and keeps its original error primary");
    assert.equal(existsSync(join(root.path, "home")), true, "the collision entry is never adopted for removal");
    assert.equal(existsSync(root.path), true, "the unaccounted root stays in place for reporting");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a foreign journal inside a receipted observer directory is retained even when observer is mutable", () => {
  const root = createControlRoot();
  try {
    // The observer directory genuinely belongs to this fixture...
    const observer = join(root.path, "observer");
    assert.equal(recordSetupDirectory(observer), true, "the observer directory is this control's own creation");
    // ...but a foreign journal already occupies the name the setup would create.
    const journal = join(observer, "native-main.jsonl");
    writeFileSync(journal, "foreign journal bytes\n", { flag: "wx", mode: 0o600 });
    let setupError: unknown;
    try {
      createSetupFile(journal, "");
    } catch (error) {
      setupError = error;
    }
    assert.match(String(setupError), /EEXIST/,
      "the setup's exclusive journal creation failed on the foreign journal and stays the primary failure");

    let captureError: unknown;
    try {
      captureSetupInventory(root.path, root.receipt, { mutableDirectories: ["observer"] });
    } catch (error) {
      captureError = error;
    }
    const detail = captureError instanceof Error ? captureError.message : String(captureError);
    assert.match(detail, /did not positively create/,
      "a runtime write grant never makes an unreceipted descendant removable");
    assert.ok(detail.includes(journal) && detail.includes(root.path),
      `the refusal names the exact journal path and the retained root: ${detail}`);
    assert.equal(existsSync(journal), true, "the foreign journal is never adopted for removal");
    assert.equal(existsSync(root.path), true, "the root stays in place for reporting");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }

  // The same shape without a collision is fully owned and removable.
  const clean = createControlRoot();
  try {
    const observer = join(clean.path, "observer");
    assert.equal(recordSetupDirectory(observer), true);
    createSetupFile(join(observer, "native-main.jsonl"), "");
    const inventory = captureSetupInventory(clean.path, clean.receipt, { mutableDirectories: ["observer"] });
    const outcome = disposeFixtureRoot({
      label: "receipted observer partial fixture",
      root: clean.path,
      receipt: clean.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    });
    assert.equal(outcome.removed, true, "a positively created partial tree is removed when no collision occurred");
  } finally {
    if (existsSync(clean.path)) removeControlRoot(clean);
  }
});

disposalTest("a late file below a completed setup producer is refused at teardown with its exact path", () => {
  const root = createControlRoot();
  try {
    const producer = join(root.path, "compiled");
    assert.equal(recordSetupDirectory(producer), true, "this control created the producer directory");
    // Confined producer output: written by a child process, so no file of its
    // own carries a creation receipt.
    writeFileSync(join(producer, "main.js"), "compiled output\n", { flag: "wx", mode: 0o600 });

    // While the producer has not completed, its descendants still need
    // individual receipts, so the capture refuses.
    assert.throws(() => captureSetupInventory(root.path, root.receipt, { setupProducers: [] }),
      new RegExp(`did not positively create.*${escapeRegExp(join(producer, "main.js"))}`));

    // Once it completed, its output is inventoried from the scan instead.
    const inventory = captureSetupInventory(root.path, root.receipt, { setupProducers: ["compiled"] });
    assert.ok([...inventory.entries.keys()].includes(join("compiled", "main.js")),
      "completed producer output is inventoried, not skipped");

    // A late unowned file below the producer must stop removal, naming itself.
    const late = join(producer, "late-unowned.txt");
    writeFileSync(late, "late\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => disposeFixtureRoot({
      label: "completed producer fixture", root: root.path, receipt: root.receipt, inventory,
      settled: true, preserve: false, report: () => undefined,
    }), new RegExp(`entry setup did not record.*${escapeRegExp(late)}`));
    assert.equal(existsSync(late), true, "a late unowned file below a producer is never deleted");
    assert.equal(existsSync(root.path), true, "the fixture root stays so the evidence is not destroyed");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a pre-existing compile destination stops the staging compile before it runs", () => {
  const root = createControlRoot();
  try {
    // A foreign directory already occupies the compile destination.
    const compiled = join(root.path, "compiled");
    mkdirSync(compiled, { mode: 0o700 });
    let producerRan = false;
    assert.throws(() => compileAndStageCandidate(root.path, () => { producerRan = true; }),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST");
    assert.equal(producerRan, false, "a refused compile destination never reports a completed producer");
    assert.deepEqual(readdirSync(compiled), [], "the compiler never wrote into the refused destination");
    assert.equal(existsSync(join(root.path, "candidate-package")), false, "staging never started either");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

/** A driver whose exact outer handle reports its own exit once signalled, with
 * every settlement release recorded so a force-path journal fault is observable. */
function attachForceTeardownStub(
  driver: PosixLauncherPtyDriver,
  forceJournal: string,
  releases: string[],
  signals: string[],
): void {
  const exitSignal = new ChangeSignal();
  const watcher = { close: () => releases.push("watcher"), unref: () => undefined };
  Object.assign(driver, {
    exitEvent: undefined,
    forced: false,
    forceJournal,
    exitSignal,
    kernelWatchers: [],
    pty: {
      pid: 4321,
      kill: (signal?: string) => {
        signals.push(String(signal));
        // The exact handle reports its own exit once signalled.
        driver.exitEvent = { exitCode: 0, signal: undefined };
        exitSignal.notify();
      },
    },
    dataSubscription: { dispose: () => releases.push("data") },
    exitSubscription: { dispose: () => releases.push("exit") },
    surface: { dispose: () => releases.push("surface") },
    logWatcher: watcher,
    nativeWatcher: watcher,
    providerWatcher: watcher,
  });
}

disposalTest("an unwritable force journal still signals the exact handle and reports the settlement fault", async () => {
  const root = createControlRoot();
  const releases: string[] = [];
  const signals: string[] = [];
  try {
    // A directory occupies the force-journal destination, so the diagnostic
    // append genuinely fails while the owned outer handle is still alive.
    const forceJournal = join(root.path, "force-events.jsonl");
    mkdirSync(forceJournal, { mode: 0o700 });
    const driver = Object.create(PosixLauncherPtyDriver.prototype) as PosixLauncherPtyDriver;
    attachForceTeardownStub(driver, forceJournal, releases, signals);

    await assert.rejects(() => driver.settleSubscriptions(),
      /POSIX source-launcher settlement unconfirmed.*launcher failure-teardown journal write failed/s);
    assert.deepEqual(signals, ["SIGTERM"],
      "the bounded exact-handle signal and wait still ran after the journal fault");
    assert.deepEqual(releases, ["data", "exit", "surface", "watcher", "watcher", "watcher"],
      "every remaining settlement release stays independent of the force-path fault");
    assert.equal(driver.forcedCleanup, true, "the one-shot force flag still records the attempt");
    assert.equal(existsSync(root.path), true, "the unconfirmed settlement retains the evidence root");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a replaced force journal receives no append while the exact handle is still signalled", async () => {
  const root = createControlRoot();
  const releases: string[] = [];
  const signals: string[] = [];
  const forceJournal = join(root.path, "force-events.jsonl");
  try {
    // The leg's own recorded journal, then a distinct regular file occupying the
    // same path. The diagnostic append has to be refused by the opened
    // descriptor, because a later disposal refusal cannot undo the write.
    createSetupFile(forceJournal, '{"type":"recorded"}\n');
    const foreignBytes = "foreign force journal bytes\n";
    const planted = join(root.path, "planted-force.jsonl");
    writeFileSync(planted, foreignBytes, { flag: "wx", mode: 0o600 });
    assert.notEqual(lstatSync(planted, { bigint: true }).ino, lstatSync(forceJournal, { bigint: true }).ino,
      "the planted file is a distinct incarnation");
    renameSync(planted, forceJournal);

    const driver = Object.create(PosixLauncherPtyDriver.prototype) as PosixLauncherPtyDriver;
    attachForceTeardownStub(driver, forceJournal, releases, signals);

    await assert.rejects(() => driver.settleSubscriptions(),
      /POSIX source-launcher settlement unconfirmed.*force journal no longer matches its recorded incarnation/s);
    assert.deepEqual(signals, ["SIGTERM"],
      "the bounded exact-handle signal and wait still ran after the refused diagnostic");
    assert.deepEqual(releases, ["data", "exit", "surface", "watcher", "watcher", "watcher"],
      "every remaining settlement release stays independent of the refused diagnostic");
    assert.equal(driver.forcedCleanup, true, "the one-shot force flag still records the attempt");
    assert.equal(readFileSync(forceJournal, "utf8"), foreignBytes, "the replacement file received no diagnostic byte");
    assert.equal(existsSync(root.path), true, "the unconfirmed settlement retains the evidence root");
    // This control owns the planted replacement, so it removes it explicitly.
    unlinkSync(forceJournal);
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

for (const lane of ["source launcher", "Saved Main"] as const) {
  disposalTest(`${lane} closes observers after an unconfirmed kernel exit without discarding evidence`, async () => {
    const root = createControlRoot();
    const filesystemWatchers = [] as ReturnType<typeof watch>[];
    try {
      const evidence = join(root.path, "evidence.jsonl");
      createSetupFile(evidence, "original evidence\n");
      const inventory = captureSetupInventory(root.path, root.receipt);
      for (let index = 0; index < (lane === "source launcher" ? 3 : 2); index++) {
        filesystemWatchers.push(watch(root.path));
      }
      const closes = filesystemWatchers.map((watcher) => once(watcher, "close"));
      const releases: string[] = [];
      const handles = {
        exitEvent: { exitCode: 0, signal: undefined },
        dataSubscription: { dispose: () => releases.push("data") },
        exitSubscription: { dispose: () => releases.push("exit") },
        surface: { dispose: () => releases.push("surface") },
      };
      const observer = {
        pid: 4321,
        observedExit: false,
        waitForExit: async () => { throw new Error("no kernel exit seen"); },
        stop: async () => { releases.push("observer"); return true; },
      };
      const missingExit = lane === "source launcher" ? /unobserved kernel exits: 4321/ : /kernel-exited ledger/;
      if (lane === "source launcher") {
        const driver = Object.create(PosixLauncherPtyDriver.prototype) as PosixLauncherPtyDriver;
        Object.assign(driver, handles, {
          kernelWatchers: [observer], logWatcher: filesystemWatchers[0],
          nativeWatcher: filesystemWatchers[1], providerWatcher: filesystemWatchers[2],
        });
        await assert.rejects(driver.settleSubscriptions(), missingExit);
      } else {
        const driver = Object.create(SavedMainDriver.prototype) as SavedMainDriver;
        const entry = { pid: observer.pid, cwd: root.path, exitWatcher: observer };
        Object.assign(driver, handles, {
          ledger: { all: () => [entry], byReceipt: () => entry },
          observerWatcher: filesystemWatchers[0], ptyWatcher: filesystemWatchers[1],
          runnerResultIfAvailable: () => ({ journalFailed: false }),
          ptyRecords: () => [{ type: "pty_spawn", receipt: 1, pid: observer.pid, cwd: root.path }],
        });
        assert.throws(() => driver.assertExactSpawnReconciliation(true), missingExit);
        await driver.releaseObservationResources();
        assert.throws(() => driver.assertExactSpawnReconciliation(true), missingExit);
      }
      assert.deepEqual([...releases].sort(), ["data", "exit", "observer", "surface"],
        "terminal teardown releases subscriptions, surface, and the owned observer exactly once");
      await Promise.all(closes);
      assert.equal(observer.observedExit, false, "stopping observation does not certify target exit");
      assert.throws(() => disposeFixtureRoot({
        label: lane, root: root.path, receipt: root.receipt, inventory,
        settled: observer.observedExit, preserve: preserveRequested(), report: assert.fail,
      }), /settlement is unconfirmed; retained evidence at/);
      assert.equal(readFileSync(evidence, "utf8"), "original evidence\n");
    } finally {
      for (const watcher of filesystemWatchers) watcher.close();
      removeControlRoot(root);
    }
  });
}

disposalTest("boundedJsonl refuses a recorded journal reached through a replaced parent directory", () => {
  const root = createControlRoot();
  const observer = join(root.path, "observer");
  const journal = join(observer, "native-main.jsonl");
  try {
    createOwnedDirectory(root.path, "observer");
    writeOwnedFile(journal, '{"type":"session_start"}\n');
    // The recorded parent is moved aside and its old path now resolves through a
    // directory symlink into a different directory holding a regular JSONL file.
    renameSync(observer, join(root.path, "observer-moved"));
    const target = join(root.path, "observer-target");
    mkdirSync(target, { mode: 0o700 });
    const foreign = join(target, "native-main.jsonl");
    const foreignBytes = '{"type":"foreign settlement evidence"}\n';
    writeFileSync(foreign, foreignBytes, { flag: "wx", mode: 0o600 });
    symlinkSync(target, observer);

    // The original recorded path is what the lanes read: the ledger lookup must
    // still find the original receipt and the identity check must then refuse
    // whatever the replaced parent now resolves to.
    assert.throws(() => boundedJsonl(journal),
      /task-created file identity is absent or changed/);
    assert.equal(readFileSync(foreign, "utf8"), foreignBytes,
      "the shared reader never returns or rewrites a foreign journal's records");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a receipted journal append settles while a late sibling in that directory is refused", () => {
  // Neither native lane grants runtime writes to the observer directory or the
  // provider-state directory: each journal is created by setup and its public
  // fixture only ever appends to that one file, which leaves its dev/ino
  // identity intact, so removal re-verifies the file instead of skipping it.
  for (const [directory, journalName] of [
    ["observer", "native-main.jsonl"], ["fixture-state", "provider-journal.jsonl"],
  ] as const) {
    const appended = createControlRoot();
    try {
      const state = createOwnedDirectory(appended.path, directory);
      const journal = join(state, journalName);
      createSetupFile(journal, '{"type":"session_start"}\n');
      const inventory = captureSetupInventory(appended.path, appended.receipt, { mutableDirectories: [] });
      appendFileSync(journal, '{"type":"agent_settled"}\n');
      const outcome = disposeFixtureRoot({
        label: `${directory} append fixture`, root: appended.path, receipt: appended.receipt, inventory,
        settled: true, preserve: false, report: () => undefined,
      });
      assert.equal(outcome.removed, true,
        `an append to the receipted ${journalName} still verifies by identity and removes the root`);
    } finally {
      if (existsSync(appended.path)) removeControlRoot(appended);
    }

    const late = createControlRoot();
    try {
      const state = createOwnedDirectory(late.path, directory);
      const journal = join(state, journalName);
      createSetupFile(journal, "");
      const inventory = captureSetupInventory(late.path, late.receipt, { mutableDirectories: [] });
      const sibling = join(state, "late-sibling.jsonl");
      writeFileSync(sibling, "not this fixture's setup\n", { flag: "wx", mode: 0o600 });
      assert.throws(() => disposeFixtureRoot({
        label: `${directory} late sibling fixture`, root: late.path, receipt: late.receipt, inventory,
        settled: true, preserve: false, report: () => undefined,
      }), new RegExp(`entry setup did not record.*${escapeRegExp(sibling)}`));
      assert.equal(existsSync(sibling), true, `a late sibling in ${directory} is never deleted`);
      assert.equal(existsSync(late.path), true, "the root stays so the refusal is not turned into a deletion");
      // This control owns the sibling probe it just planted, so removing it keeps
      // the teardown hygiene honest instead of leaving a stray root behind.
      unlinkSync(sibling);
    } finally {
      if (existsSync(late.path)) removeControlRoot(late);
    }
  }
});

disposalTest("a swapped-in observer directory is refused before any journal is written into it", () => {
  const root = createControlRoot();
  const observer = join(root.path, "observer");
  try {
    // The leg creates its observer directory during setup, then compiles and
    // stages its candidate before startup writes the journal into it.
    assert.equal(recordSetupDirectory(observer), true, "the leg's own exclusive creation is recorded");
    const recorded = fixtureCreationReceipt(observer);
    assert.ok(recorded !== undefined, "the recorded directory has a receipt");
    // That interval is where a replacement can land: an empty foreign directory
    // (allocated while the recorded one still existed, so a distinct incarnation)
    // ends up occupying the same canonical path.
    const planted = join(root.path, "planted-observer");
    mkdirSync(planted, { mode: 0o700 });
    assert.notEqual(lstatSync(planted, { bigint: true }).ino, recorded!.ino,
      "the planted directory is a distinct incarnation");
    renameSync(planted, observer);
    assert.throws(() => assertPositivelyCreatedDirectory(observer, "the POSIX source-launcher observer directory"),
      new RegExp(`not a directory this test positively created.*${escapeRegExp(observer)}`));
    assert.deepEqual(readdirSync(observer), [], "startup leaves the replacement empty");

    // The establishment path a caller without a precreated directory takes still
    // creates it exclusively and records it.
    rmSync(observer, { recursive: true });
    establishPositivelyCreatedDirectory(observer, "the native Main observer directory");
    assert.equal(fixtureCreationReceipt(observer)?.directory, true, "the established directory is recorded");
    assert.throws(() => mkdirSync(observer, { mode: 0o700 }), /EEXIST/, "the directory exists exclusively");
    assert.deepEqual(readdirSync(observer), [], "establishing the directory writes nothing into it");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a PTY spawn failure releases every watcher, reports a throwing close, and keeps the spawn error primary", () => {
  const previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  const previousCatalog = process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG;
  const fsModule = require("node:fs") as { watch: unknown };
  const originalWatch = fsModule.watch;
  const closes: string[] = [];
  const faults: string[] = [];
  let layoutRoot: string | undefined;
  let layoutReceipt: FixtureRootReceipt | undefined;
  try {
    // The patched watcher factory is test-only: it lets the real driver startup
    // failure path run against a watcher whose close genuinely throws.
    let ordinal = 0;
    fsModule.watch = () => {
      const id = `watcher-${ordinal++}`;
      return {
        close: () => {
          closes.push(id);
          if (id === "watcher-0") throw new Error("synthetic watcher close fault");
        },
        on: () => undefined,
      };
    };
    const layout = createLauncherLegLayout((root) => {
      layoutRoot = root;
      layoutReceipt = fixtureRootReceipt(root);
    });
    const spawnFailure = new Error("synthetic PTY spawn failure");
    const runtime: PosixLauncherRuntimePin = {
      sourceRoot: process.cwd(),
      agentDir: layout.nativeAgentDir,
      piExecutable: join(process.cwd(), "scripts", "pi-review-sessions.cjs"),
      version: "1.6.1",
      python: join(dirname(process.execPath), "python3"),
      bash: "/bin/bash",
      nodeBinDir: dirname(process.execPath),
      pty: {
        spawn: () => { throw spawnFailure; },
      },
      ptyModulePath: "synthetic",
      preloadFixture: join(process.cwd(), "tests", "fixtures", "session-host-posix-launcher-preload.cjs"),
    };
    const deadline = new LegDeadline(5_000);
    let spawnAttempted = false;
    let thrown: unknown;
    try {
      PosixLauncherPtyDriver.start({
        runtime, layout, nonce: "spawn-failure-fault", deadline,
        onSpawnAttempt: () => { spawnAttempted = true; },
        onSetupSettlementFault: (detail) => faults.push(detail),
      });
    } catch (error) {
      thrown = error;
    } finally {
      deadline.dispose();
    }
    fsModule.watch = originalWatch;

    assert.equal(spawnAttempted, true, "the control reached the real spawn boundary");
    assert.match(String(thrown), /public POSIX source launcher PTY spawn failed/,
      "the contextual startup failure is what the caller sees");
    assert.match(String((thrown as { cause?: unknown }).cause), /synthetic PTY spawn failure/,
      "the original spawn exception is attached as the cause, never swallowed");
    assert.deepEqual(closes, ["watcher-0", "watcher-1", "watcher-2"],
      "a throwing close does not skip the remaining acquired releases");
    assert.equal(faults.length, 1, "the close fault is reported separately to the finalizer");
    assert.match(faults[0] ?? "", /launcher spawn-failure watcher close failed.*synthetic watcher close fault/s);

    // The same failed start still owns exactly what its creation ledger recorded,
    // so its partial fixture is removable while the spawn fault stays primary.
    assert.ok(layoutRoot !== undefined && layoutReceipt !== undefined);
    const inventory = captureSetupInventory(layoutRoot!, layoutReceipt!, {
      mutableDirectories: ["home", "tmp", "cache", "state", "fixture-state", "observer", "native-agent"],
    });
    const outcome = disposeFixtureRoot({
      label: "spawn-failure partial fixture",
      root: layoutRoot!,
      receipt: layoutReceipt!,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    });
    assert.equal(outcome.removed, true, "the known partial setup root is removed after the failed start");
  } finally {
    fsModule.watch = originalWatch;
    if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
    if (previousCatalog === undefined) delete process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG;
    else process.env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG = previousCatalog;
    if (layoutRoot !== undefined && existsSync(layoutRoot)) rmSync(layoutRoot, { recursive: true, force: false });
  }
});

test("owned PID watcher stop exposes confirmed process closure", {
  skip: WINDOWS_SKIP || (PYTHON_AVAILABLE ? false : "python3 3.9 or newer is required for the kernel exit watcher"),
}, async () => {
  const python = process.env.PI_REVIEW_GATE_LAUNCHER_PYTHON?.trim() || "python3";
  const watchers = [
    new OwnedPidExitWatcher(process.pid),
    new PosixKernelExitWatcher(process.pid, {
      python,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      cwd: process.cwd(),
    }),
  ];
  try {
    for (const watcher of watchers) await watcher.waitUntilRegistered(10_000);
    for (const watcher of watchers) {
      const child = (watcher as unknown as { child: { kill(signal?: string): boolean } }).child;
      const originalKill = child.kill;
      child.kill = () => true; // withhold both signals: close never arrives
      try {
        assert.equal(await watcher.stop(25), false,
          "a watcher process whose close event never arrives is not confirmed closed");
      } finally {
        child.kill = originalKill;
      }
      assert.equal(await watcher.stop(5_000), true, "the real watcher process closes and stop reports it");
    }
  } finally {
    for (const watcher of watchers) await watcher.stop(5_000);
  }
});

disposalTest("a strict entry introduced after pre-spawn capture refuses removal", () => {
  const root = createControlRoot();
  try {
    mkdirSync(join(root.path, "workspace"), { mode: 0o700 });
    // This is the ownership snapshot both native lanes now take in onPrepared,
    // before any watcher or PTY spawn.
    const inventory = captureFixtureInventory(root.path, root.receipt);
    writeFileSync(join(root.path, "workspace", "started-late.txt"), "late\n", { flag: "wx", mode: 0o600 });
    assert.throws(() => disposeFixtureRoot({
      label: "focused pre-spawn capture fixture",
      root: root.path,
      receipt: root.receipt,
      inventory,
      settled: true,
      preserve: false,
      report: () => undefined,
    }), /entry setup did not record/);
    assert.equal(existsSync(join(root.path, "workspace", "started-late.txt")), true,
      "a strict entry written after the pre-spawn snapshot is never adopted for removal");
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("strict Saved Main disposal attempts every release and reports faults", () => {
  const calls: string[] = [];
  const driver = Object.create(SavedMainDriver.prototype) as SavedMainDriver;
  Object.assign(driver, {
    dataSubscription: { dispose: () => { calls.push("data"); throw new Error("data fault"); } },
    exitSubscription: { dispose: () => { calls.push("exit"); } },
    surface: { dispose: () => { calls.push("surface"); } },
    observerWatcher: { close: () => { calls.push("observer"); throw new Error("observer fault"); } },
    ptyWatcher: { close: () => { calls.push("pty"); } },
  });
  assert.throws(() => driver.dispose(true),
    /Saved Main handle disposal failed: .*data fault.*observer fault/s);
  assert.deepEqual(calls, ["data", "exit", "surface", "observer", "pty"],
    "a throwing release does not prevent the remaining owned releases");

  calls.length = 0;
  assert.doesNotThrow(() => driver.dispose(false),
    "the ordinary pre-release path keeps its best-effort behavior");
  assert.deepEqual(calls, ["data", "exit", "surface", "observer", "pty"]);
});

disposalTest("a foreign Saved Main control replacement is refused and left untouched", () => {
  const root = createControlRoot();
  const controlFile = join(root.path, "saved-main-control.json");
  const tempPath = join(root.path, "saved-main-control-1.tmp");
  try {
    createSetupFile(controlFile, '{"requestId":0,"action":"start"}\n');
    const original = lstatSync(controlFile, { bigint: true });
    const driver = Object.create(SavedMainDriver.prototype) as SavedMainDriver;
    Object.assign(driver, {
      controlFile,
      controlReceipt: { dev: original.dev, ino: original.ino },
      controlRequestId: 0,
    });
    const send = (): number =>
      (driver as unknown as { sendRunnerControl(action: "release"): number }).sendRunnerControl("release");

    // A different regular file now occupies the destination.
    const foreignBytes = "foreign replacement request bytes\n";
    const foreignPath = join(root.path, "planted-replacement.json");
    writeFileSync(foreignPath, foreignBytes, { flag: "wx", mode: 0o600 });
    const replacement = lstatSync(foreignPath, { bigint: true });
    assert.notEqual(replacement.ino, original.ino, "the planted file is a distinct incarnation");
    renameSync(foreignPath, controlFile);

    assert.throws(send, /no longer the recorded incarnation before a new Saved Main control request was written/s);
    assert.equal(readFileSync(controlFile, "utf8"), foreignBytes,
      "the refusal neither overwrites nor renames over the replacement");
    const afterReplacement = lstatSync(controlFile, { bigint: true });
    assert.equal(afterReplacement.dev, replacement.dev, "the replacement keeps its own device");
    assert.equal(afterReplacement.ino, replacement.ino, "the replacement keeps its own inode");
    assert.deepEqual(driver.controlFileReceipt, { dev: original.dev, ino: original.ino },
      "the previously recorded receipt survives the refusal, so teardown reports the mismatch");
    assert.equal(existsSync(tempPath), false, "the refusal happens before any temporary request file is written");

    // The same guard runs again immediately before the rename. With this call's
    // own temporary request already written and the replacement still in place,
    // publication stays refused instead of displacing the foreign file.
    writeFileSync(tempPath, '{"requestId":1,"action":"release"}\n', { flag: "wx", mode: 0o600 });
    const guard = (stage: string): void => (driver as unknown as {
      assertControlFileIncarnation(stage: string): void;
    }).assertControlFileIncarnation(stage);
    assert.throws(() => guard("immediately before the Saved Main control request rename"),
      /no longer the recorded incarnation immediately before the Saved Main control request rename/s);
    assert.equal(readFileSync(controlFile, "utf8"), foreignBytes, "the rename never started on the replacement");
    assert.equal(readFileSync(tempPath, "utf8"), '{"requestId":1,"action":"release"}\n',
      "this call's own temporary request file stays where it was written");

    // This control owns both planted artifacts, so it removes them itself and
    // leaves no root behind.
    unlinkSync(tempPath);
    unlinkSync(controlFile);
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("a refused Saved Main release still runs the bounded outer fallback and reports the refusal", async () => {
  const root = createControlRoot();
  const controlFile = join(root.path, "saved-main-control.json");
  const signals: string[] = [];
  try {
    createSetupFile(controlFile, '{"requestId":0,"action":"start"}\n');
    const original = lstatSync(controlFile, { bigint: true });
    createSetupFile(join(root.path, "saved-main-result.json"), "");
    createSetupFile(join(root.path, "saved-main-pty-journal.jsonl"), "");
    const driver = Object.create(SavedMainDriver.prototype) as SavedMainDriver;
    const exitSignal = new ChangeSignal();
    let outerWaits = 0;
    Object.assign(driver, {
      exitEvent: undefined,
      exitSignal,
      // Positive child reconciliation: every exact receipt already observed its
      // kernel exit, which is the state in which the release is attempted.
      ledger: { all: () => [] },
      resultFile: join(root.path, "saved-main-result.json"),
      ptyJournalFile: join(root.path, "saved-main-pty-journal.jsonl"),
      outerKillAttempts: [],
      controlFile,
      controlReceipt: { dev: original.dev, ino: original.ino },
      controlRequestId: 0,
      runnerReleased: false,
      controlRefusal: undefined,
      pty: {
        kill: (signal?: string) => {
          signals.push(String(signal));
          // The exact outer handle reports its exit only to the fallback signal,
          // so the release attempt happens while the runner is still alive.
          if (signals.length > 1) {
            driver.exitEvent = { exitCode: 0, signal: undefined };
            exitSignal.notify();
          }
          return true;
        },
      },
      waitForRunnerResult: async () => { throw new Error("no runner result within the bounded window"); },
      waitForOuterExit: async () => {
        outerWaits += 1;
        if (outerWaits === 1) throw new Error("the outer runner is still waiting for release");
        return driver.exitEvent!;
      },
    });

    // A foreign regular file occupies the control destination.
    const foreignBytes = "foreign release request bytes\n";
    const foreignPath = join(root.path, "planted-release.json");
    writeFileSync(foreignPath, foreignBytes, { flag: "wx", mode: 0o600 });
    const replacement = lstatSync(foreignPath, { bigint: true });
    assert.notEqual(replacement.ino, original.ino, "the planted file is a distinct incarnation");
    renameSync(foreignPath, controlFile);

    await assert.rejects(() => driver.terminateExactOuterForFailure(),
      /no longer the recorded incarnation before a new Saved Main control request was written/s);

    assert.deepEqual(signals, ["SIGTERM", "SIGTERM"],
      "the owner grace request and the bounded exact-outer-handle fallback both ran despite the refusal");
    assert.ok(driver.exitEvent !== undefined,
      "the outer handle settled, and the refusal is still what failure teardown reports");
    assert.equal(driver.outerKillAttempts.length, 2, "both bounded outer attempts are recorded");
    assert.equal(readFileSync(controlFile, "utf8"), foreignBytes,
      "no further control request overwrote or renamed over the replacement");
    const afterReplacement = lstatSync(controlFile, { bigint: true });
    assert.equal(afterReplacement.dev, replacement.dev, "the replacement keeps its own device");
    assert.equal(afterReplacement.ino, replacement.ino, "the replacement keeps its own inode");
    assert.deepEqual(driver.controlFileReceipt, { dev: original.dev, ino: original.ino },
      "the previous receipt survives, so the finalizer still reports the mismatch and retains the tree");
    assert.equal(readdirSync(root.path).filter((name) => name.endsWith(".tmp")).length, 0,
      "the fallback never writes another control request");

    // The refusal is sticky: a later release attempt reports the same original
    // refusal, records nothing as done, and still writes no control request.
    const release = (): void => (driver as unknown as { releaseRunner(): void }).releaseRunner();
    assert.throws(release, /no longer the recorded incarnation before a new Saved Main control request was written/s);
    const state = driver as unknown as { runnerReleased: boolean; controlRefusal?: Error };
    assert.equal(state.runnerReleased, false, "the refused release is never recorded as done");
    assert.match(String(state.controlRefusal?.message ?? state.controlRefusal),
      /no longer the recorded incarnation/, "the original refusal is what stays recorded");
    assert.equal(readdirSync(root.path).filter((name) => name.endsWith(".tmp")).length, 0,
      "the sticky refusal writes no control request either");

    unlinkSync(controlFile);
  } finally {
    if (existsSync(root.path)) removeControlRoot(root);
  }
});

disposalTest("partial watcher setup attempts every close and reports each failure", () => {
  const calls: string[] = [];
  const faults: string[] = [];
  closeAcquiredWatchers([
    { close: () => { calls.push("first"); throw new Error("first close fault"); } },
    { close: () => { calls.push("second"); } },
    { close: () => { calls.push("third"); throw new Error("third close fault"); } },
  ], (detail) => faults.push(detail));
  assert.deepEqual(calls, ["first", "second", "third"],
    "a throwing close does not prevent the remaining acquired watcher releases");
  assert.equal(faults.length, 2, "each watcher close fault is reported separately");
  assert.match(faults.join(" | "), /first close fault/);
  assert.match(faults.join(" | "), /third close fault/);
});

test("a timed-out body registers teardown before allocation and retains its reported root", () => {
  const helperPath = join(__dirname, "helpers", "scratch-fixture-base.js");
  // The control root name deliberately contains spaces: a retained path the
  // child reports is evidence, never something re-parsed into a deletion path.
  const controlRoot = mkdtempSync(join(retainedFixtureBase(), "prg timeout control-"));
  const controlReceipt = fixtureRootReceipt(controlRoot);
  try {
    const testFile = join(controlRoot, "timeout.test.cjs");
    writeFileSync(testFile, `
      const test = require("node:test");
      const { mkdtempSync, writeFileSync } = require("node:fs");
      const { join } = require("node:path");
      const base = require(${JSON.stringify(helperPath)});
      test("timed-out body", { timeout: 200 }, async (t) => {
        // The hook is registered before the first allocation, exactly as the
        // real lanes do, so a body that never unwinds still settles.
        let root;
        let receipt;
        let inventory;
        t.after(() => {
          try {
            base.disposeFixtureRoot({
              label: "timed-out body control",
              root,
              receipt,
              inventory,
              settled: false,
              unsettledDetail: "test ended before its body finished",
              preserve: false,
              report: (line) => console.log(line),
            });
          } catch (error) {
            console.log("RETAINED=" + root);
            console.log("REFUSAL=" + error.message);
          }
        });
        root = mkdtempSync(join(${JSON.stringify(controlRoot)}, "prg-timeout-root-"));
        receipt = base.fixtureRootReceipt(root);
        writeFileSync(join(root, "owned.txt"), "owned\\n", { flag: "wx", mode: 0o600 });
        inventory = base.captureFixtureInventory(root, receipt);
        await new Promise(() => {});
      });
    `, { flag: "wx", mode: 0o600 });
    // This control spawns its own node:test process. The inherited runner
    // context markers make that nested run skip its files silently, so they are
    // cleared for this test child only; the assertions below still require the
    // real timeout failure and the real refusal output.
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    delete childEnv.NODE_TEST_WORKER_ID;
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
      encoding: "utf8",
      timeout: 10_000,
      env: childEnv,
    });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    assert.notEqual(run.status, 0, output);
    assert.doesNotMatch(output, /recursively within a test file/,
      "the control child actually ran its own test file instead of skipping it");
    assert.match(output, /timed out/i, "the original node:test timeout failure stays visible");
    // The child runs under the TAP reporter, which prefixes each stdout line.
    const reported = /^(?:#\s*)?RETAINED=(.*)$/m.exec(output)?.[1];
    assert.ok(reported !== undefined, `the registered fixture path is reported on refusal:\n${output}`);
    assert.match(output, /settlement is unconfirmed/, "the refusal keeps the evidence path visible");
    // The retained directory is identified inside the parent's own control root,
    // never by parsing subprocess output.
    const retained = readdirSync(controlRoot).filter((name) => name.startsWith("prg-timeout-root-"));
    assert.equal(retained.length, 1, "the child allocated exactly one root beneath the parent's control root");
    const retainedPath = join(controlRoot, retained[0]);
    assert.equal(reported, retainedPath, "the child reports the exact space-bearing path it retained");
    assert.equal(existsSync(retainedPath), true, "a body still running at teardown never authorizes removal");
  } finally {
    // Cleanup only ever removes the parent's own exclusively created, receipted
    // control root, which contains whatever the child retained.
    const entry = lstatSync(controlRoot, { bigint: true, throwIfNoEntry: false });
    assert.ok(entry !== undefined && entry.isDirectory() && entry.dev === controlReceipt.dev
      && entry.ino === controlReceipt.ino, `the control still owns its control root: ${controlRoot}`);
    rmSync(controlRoot, { recursive: true, force: false });
  }
});
