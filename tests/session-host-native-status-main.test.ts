/**
 * Main-level activation tests for the concrete native status source
 * (issue #277 native status activation).
 *
 * These prove the host's wiring, not the pipeline's semantics: a host that
 * offers native provider sessions hands the manager the EXACT broker object it
 * already created - the one listener its Pi reporters use - plus the concrete
 * observer factory, alongside the existing interactive launcher. A host whose
 * broker facade carries only the Pi family, and a host with no native hosting at
 * all, keep the manager options they had before this slice.
 *
 * The synthetic Main harness supplies the terminal, writer, and manager double;
 * the broker in the arming test is the REAL local status broker on a REAL bound
 * socket. No provider CLI, provider configuration, model, or permission state is
 * involved, and no child is ever spawned.
 */

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createStatusBroker, type NativeHookStatusBroker } from "../src/session-host/broker";
import { createNativeStatusObserver } from "../src/session-host/native-observer-factory";
import type { SidebarNativeCliTarget } from "../src/session-host/sidebar";

import {
  createHarness,
  nextTurn,
  ready,
  type FakeManager,
  type Harness,
  type MainTestDependencies,
} from "./helpers/session-host-main-harness";

const ENTER = "\r";

const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
];

const ownedRoots = new Set<string>();

/** A short owned root: the broker's Unix socket path has a tight OS bound. */
function makeSocketRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-nsm-")));
  ownedRoots.add(root);
  return root;
}

/** One launcher double: it never resolves a real executable. */
function hostingWithLauncher() {
  return () => ({
    targets: TARGETS,
    launch: async (backend: "claude" | "codex", request: { workspace: string; env: NodeJS.ProcessEnv }) => ({
      file: `/synthetic/${backend}`,
      args: [],
      env: { ...request.env },
      cwd: request.workspace,
    }),
  });
}

/** Submit the New form as the ordinary Pi create it must stay. */
async function submitPiCreate(harness: Harness, workspace: string): Promise<void> {
  harness.terminal.emitInput(ENTER); // the selected New session row
  harness.terminal.emitInput("\x15"); // replace any retained draft
  harness.terminal.emitInput(workspace);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
}

async function closeHarness(harness: Harness, broker?: NativeHookStatusBroker): Promise<void> {
  harness.signals.emit("SIGTERM");
  await harness.result;
  if (broker !== undefined) {
    try {
      await broker.dispose();
    } catch {
      // Main already disposed its broker; disposal is idempotent.
    }
  }
  for (const root of ownedRoots) {
    rmSync(root, { recursive: true, force: true });
    ownedRoots.delete(root);
  }
}

test("a hosting host arms native status with its ONE existing broker and the concrete observer factory", async () => {
  const socketRoot = makeSocketRoot();
  let created: NativeHookStatusBroker | undefined;
  const dependencies: MainTestDependencies = {
    // The REAL production broker, on a REAL bound local socket.
    createBroker: async () => {
      created = await createStatusBroker({ socketRoot });
      return created;
    },
    nativeCliHosting: hostingWithLauncher(),
  };
  const harness = createHarness({}, dependencies);
  try {
    const manager: FakeManager = await ready(harness);
    const broker = created;
    assert.ok(broker, "the host created its broker");

    assert.equal(typeof manager.options.nativeCliLaunch, "function",
      "the interactive launcher is still wired for a hosting host");
    assert.equal(manager.options.nativeHookRegistrar, broker,
      "the optional native registrar IS the exact broker object this host already owns, not a second facade");
    assert.equal(manager.options.nativeStatusObserverFactory, createNativeStatusObserver,
      "the concrete factory from the native observer module is the one the manager receives");

    // The pair arrives together, and the spread the owning-host service forwarded
    // keeps every existing field and the single intercepted change hook.
    assert.equal(typeof manager.options.onChange, "function");
    assert.equal(typeof manager.options.statusRegistrar.register, "function",
      "the Pi status family keeps its own adapter over the same broker");
    assert.equal(harness.events.filter((event) => event === "manager.create").length, 1,
      "one host owns exactly one manager");

    // The handed facade is the live broker: it issues a real bootstrap for a row
    // id and refuses to deliver after release.
    const registration = manager.options.nativeHookRegistrar!.registerNativeHookSource(
      "11111111-1111-4111-8111-111111111111",
      "claude",
      { onEvent: () => undefined, onFailure: () => undefined },
    );
    assert.equal(registration.bootstrap.socketPath, broker!.socketPath);
    assert.equal(registration.bootstrap.backend, "claude");
    registration.release();

    // None of this changes the ordinary Pi path: the same host still creates an
    // unmodified Pi row.
    await submitPiCreate(harness, "/plain/pi/workspace");
    assert.deepEqual(manager.createOptions.at(-1), { workspace: "/plain/pi/workspace" });
  } finally {
    await closeHarness(harness, created);
  }
});

test("native hosting over a Pi-only broker facade arms no observation path and changes nothing else", async () => {
  // The shared harness broker is the narrower Pi-only facade every existing
  // internal consumer already injects: it carries no native hook family.
  const harness = createHarness({}, { nativeCliHosting: hostingWithLauncher() });
  try {
    const manager: FakeManager = await ready(harness);

    assert.equal(typeof manager.options.nativeCliLaunch, "function",
      "the host still offers native provider sessions");
    assert.ok(!("nativeHookRegistrar" in manager.options),
      "a broker without the native hook family is never handed over as a half-registrar");
    assert.ok(!("nativeStatusObserverFactory" in manager.options),
      "without a real registrar there is no observer and no observation path at all");
    assert.deepEqual(harness.reports, [], "the narrower facade is not a host failure");

    await submitPiCreate(harness, "/plain/pi/workspace");
    assert.deepEqual(manager.createOptions.at(-1), { workspace: "/plain/pi/workspace" });
  } finally {
    await closeHarness(harness);
  }
});

test("a host with no native hosting keeps the exact legacy Pi-only manager options", async () => {
  const harness = createHarness();
  try {
    const manager: FakeManager = await ready(harness);

    assert.equal(manager.options.nativeCliLaunch, undefined);
    assert.ok(!("nativeHookRegistrar" in manager.options),
      "no hosting means no native registration, ever");
    assert.ok(!("nativeStatusObserverFactory" in manager.options),
      "no hosting means no observer construction, ever");

    await submitPiCreate(harness, "/plain/pi/workspace");
    assert.deepEqual(manager.createOptions.at(-1), { workspace: "/plain/pi/workspace" });
  } finally {
    await closeHarness(harness);
  }
});
