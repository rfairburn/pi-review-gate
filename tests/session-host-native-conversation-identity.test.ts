import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  type CreateInstanceOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeHookSourceRegistrar,
  type NativeStatusObserver,
  type NativeStatusObserverContext,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { isNativeConversationId } from "../src/session-host/native-conversation";
import type { NativeCliBackend } from "../src/session-host/session-backend";
import type { NativeHookSourceHandlers } from "../src/session-host/broker";

/**
 * Focused component coverage for the private native restart-restoration identity
 * plumbing in `InstanceManager` (issue #277 restoration identity slice).
 *
 * EVIDENCE SCOPE: synthetic PTYs, an injected test launch provider, a synthetic
 * registrar shaped like the broker's `registerNativeHookSource`, and a synthetic
 * observer that only calls the context it was handed. Nothing here runs a real
 * Claude or Codex binary or reads any provider state, and no provider resume or
 * identity proof logic exists yet: this proves the manager's owner-only identity
 * channel, its run fences, the restore expectation fence, the private getter, and
 * the private forwarding of a resume intent.
 */

const UUID_B = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const UUID_C = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";

class SpyPty implements InstancePty {
  static #nextPid = 930_000;
  readonly pid: number;
  cols: number;
  rows: number;
  exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

  constructor(descriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = descriptor.cols;
    this.rows = descriptor.rows;
  }

  onData(_listener: (data: string) => void): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => undefined };
  }
  on(_eventName: "error", _listener: (error: Error) => void): void { /* unused */ }
  removeListener(_eventName: "error", _listener: (error: Error) => void): void { /* unused */ }
  write(_data: string | Buffer): void { /* unused */ }
  resize(_cols: number, _rows: number): void { /* unused */ }
  pause(): void { /* unused */ }
  resume(): void { /* unused */ }
  kill(signal?: string): void {
    if (!this.exited && (signal ?? "SIGHUP") === "SIGTERM") this.emitExit(15);
  }
  emitExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode });
  }
}

class RecordingPiRegistrar implements StatusRegistrar {
  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/pi/${instanceId}.sock`,
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
      },
      release: () => undefined,
    };
  }
}

class SpyObserver implements NativeStatusObserver {
  /** What the identity channel answered while the factory was still running. */
  preactivation: boolean | undefined;
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(): void { /* unused */ }
  acceptFailure(): void { /* unused */ }
  dispose(): void { /* unused */ }
  identity(value: string | null): boolean {
    const emit = this.context.emitConversationIdentity;
    assert.ok(emit, "the production manager always supplies the identity channel");
    return emit(value);
  }
}

interface Harness {
  root: string;
  workspace: string;
  manager: InstanceManager;
  observers: SpyObserver[];
  spawned: SpyPty[];
  providerCalls: NativeCliLaunchRequest[];
  changes: string[];
}

function makeHarness(label: string, pair: "present" | "absent" = "present"): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-native-identity-${label}-`)));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic fixture; never executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic fixture.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic fixture.\n", "utf8");
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(join(piExecutable, ".."), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n// Synthetic inert fixture.\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const workspace = join(root, "workspace");
  for (const dir of [home, agentDir, workspace]) mkdirSync(dir, { recursive: true });

  const observers: SpyObserver[] = [];
  const spawned: SpyPty[] = [];
  const providerCalls: NativeCliLaunchRequest[] = [];
  const changes: string[] = [];
  const handlers = new Map<string, NativeHookSourceHandlers>();

  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: new RecordingPiRegistrar(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    onChange: (id) => changes.push(id),
    nativeCliLaunch: (backend: NativeCliBackend, request): NativeCliLaunchDescriptor => {
      providerCalls.push({ ...request, env: {} });
      return { file: `/synthetic/bin/${backend}`, args: ["--interactive"], env: { PATH: "/synthetic/bin", HOME: home }, cwd: request.workspace };
    },
    ...(pair === "absent"
      ? {}
      : {
        nativeHookRegistrar: {
          registerNativeHookSource: (instanceId, backend, sourceHandlers) => {
            handlers.set(instanceId, sourceHandlers);
            return {
              bootstrap: {
                version: 1,
                socketPath: `/synthetic/native/${instanceId}.sock`,
                generation: randomUUID(),
                instanceId,
                backend,
                token: randomBytes(32).toString("hex"),
              },
              release: () => { handlers.delete(instanceId); },
            };
          },
        } satisfies NativeHookSourceRegistrar,
        nativeStatusObserverFactory: (context: NativeStatusObserverContext) => {
          const observer = new SpyObserver(context);
          // Before the run's capture exists, the identity channel claims nothing.
          observer.preactivation = context.emitConversationIdentity?.(UUID_B);
          observers.push(observer);
          return observer;
        },
      }),
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });
  return { root, workspace, manager, observers, spawned, providerCalls, changes };
}

async function withHarness(label: string, body: (harness: Harness) => Promise<void>, pair: "present" | "absent" = "present"): Promise<void> {
  const harness = makeHarness(label, pair);
  try {
    await body(harness);
  } finally {
    await harness.manager.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
}

function lastObserver(harness: Harness): SpyObserver {
  const observer = harness.observers.at(-1);
  assert.ok(observer);
  return observer;
}

function changesFor(harness: Harness, id: string): number {
  return harness.changes.filter((changed) => changed === id).length;
}

test("the native conversation id rule accepts only one exact UUID", () => {
  assert.equal(isNativeConversationId(UUID_B), true);
  assert.equal(isNativeConversationId(UUID_B.toUpperCase()), true);
  for (const bad of ["", "latest", "last", "continue", "session name", "/tmp/x.jsonl", `${UUID_B} `, `{${UUID_B}}`,
    `urn:uuid:${UUID_B}`, UUID_B.replace(/-/g, ""), UUID_B.slice(1), null, undefined, 7, {}]) {
    assert.equal(isNativeConversationId(bad), false, `${JSON.stringify(bad)} is not an exact id`);
  }
});

test("a fresh native row saves a fenced proved identity, survives unknown status, and clears only on explicit live loss", async () => {
  await withHarness("fresh", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    assert.equal(observer.preactivation, false, "a preactivation identity claims nothing");
    assert.equal(observer.context.workspace, realpathSync(harness.workspace), "the context carries the canonical workspace");
    assert.equal("resumeConversationId" in observer.context, false, "a fresh row has no resume intent");
    assert.equal("resumeConversationId" in harness.providerCalls[0]!, false, "a fresh launch request is unchanged");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude" });

    // Initial lack of proof: an explicit null before any identity changes nothing.
    assert.equal(observer.identity(null), false);
    // A malformed id can never set identity.
    assert.equal(observer.identity("latest"), false);
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude" });

    const before = changesFor(harness, id);
    assert.equal(observer.identity(UUID_B), true);
    assert.equal(changesFor(harness, id), before + 1, "an identity change triggers the ordinary onChange");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude", conversationId: UUID_B });
    assert.ok(Object.isFrozen(harness.manager.readNativeConversationIdentity(id)));
    assert.equal(harness.manager.hasProvedNativeConversation(id), true, "a fresh row's first proof is its proof fact");
    assert.equal(observer.identity(UUID_B), true, "a repeated proof is accepted");
    assert.equal(changesFor(harness, id), before + 1, "and changes nothing");

    // Unknown status is not identity loss.
    assert.equal(observer.context.emit({ busy: null, pendingInput: null, activeTasks: null, activeShells: null }).accepted, true);
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude", conversationId: UUID_B });
    const view = harness.manager.list().find((row) => row.id === id);
    assert.equal(view?.busy, null, "no status fact is invented by an identity");
    assert.equal(view?.pendingInput, null);
    assert.equal(view?.activeTasks, null);
    assert.equal(view?.activeShells, null);

    // Nothing private reaches a public view or the status capture.
    const publicSnapshot = JSON.stringify(harness.manager.list());
    assert.equal(publicSnapshot.includes(UUID_B), false, "the private identity never reaches a public view");
    assert.equal(view?.nativeSession ?? null, null, "the opaque id never becomes a Pi native tuple");
    assert.equal(JSON.stringify(harness.manager.nativeStatusCapture(id)).includes(UUID_B), false);

    // A later authoritative identity follows the provider's current conversation.
    assert.equal(observer.identity(UUID_C), true);
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_C);

    // Explicit live loss clears it and persists through onChange.
    const beforeLoss = changesFor(harness, id);
    assert.equal(observer.identity(null), true);
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude" });
    assert.equal(changesFor(harness, id), beforeLoss + 1);
    assert.equal(observer.identity(null), false, "nothing active remains to withdraw");
  });
});

test("stale, retired-generation, cross-row, exited, and stopped callbacks cannot write; retirement keeps the last id", async () => {
  await withHarness("stale", async (harness) => {
    const first = await harness.manager.create({ workspace: harness.workspace, backend: "codex", nativeCliTarget: "codex-work" } as CreateInstanceOptions);
    const firstObserver = lastObserver(harness);
    const second = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const secondObserver = lastObserver(harness);

    assert.equal(firstObserver.identity(UUID_B), true);
    assert.deepEqual(harness.manager.readNativeConversationIdentity(first), { targetId: "codex-work", conversationId: UUID_B });
    assert.deepEqual(harness.manager.readNativeConversationIdentity(second), { targetId: "claude" }, "one row's identity never touches another row");

    // Unlike an ordinary unknown status snapshot, accepted invalidation loses the
    // observation generation: it can no longer track switches, so its last proved
    // restart identity is withdrawn and its later callbacks are refused.
    const capture = harness.manager.nativeStatusCapture(second);
    assert.ok(capture);
    assert.equal(secondObserver.identity(UUID_C), true);
    assert.equal(capture.invalidate().accepted, true);
    assert.equal(harness.manager.readNativeConversationIdentity(second)?.conversationId, undefined, "a lost generation cannot retain a stale restart target");
    assert.equal(secondObserver.identity(null), false, "a retired generation cannot withdraw");
    assert.equal(secondObserver.identity(UUID_B), false, "a retired generation cannot write");
    assert.equal(harness.manager.readNativeConversationIdentity(second)?.conversationId, undefined);

    // A confirmed stop retires the run; the last exact id survives for the next restart.
    const stopped = await harness.manager.stop(first, { confirmed: true });
    assert.equal(stopped.status, "exited");
    assert.equal(firstObserver.identity(null), false, "a stopped run cannot clear identity");
    assert.equal(firstObserver.identity(UUID_C), false, "a stopped run cannot write identity");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(first), { targetId: "codex-work", conversationId: UUID_B },
      "the exited row still answers with its last exact id");

    // Exit cannot resurrect the identity already lost to invalidation.
    harness.spawned.at(-1)!.emitExit(0);
    assert.equal(secondObserver.identity(null), false);
    assert.equal(harness.manager.readNativeConversationIdentity(second)?.conversationId, undefined);

    // A removed row answers nothing.
    assert.equal(harness.manager.closeExited(first), true);
    assert.equal(harness.manager.readNativeConversationIdentity(first), undefined);
  });
});

test("a restore intent is admitted only as an exact UUID on a native row, before any row exists", async () => {
  await withHarness("validation", async (harness) => {
    await assert.rejects(harness.manager.create({ workspace: harness.workspace, nativeResumeConversationId: UUID_B } as CreateInstanceOptions),
      /only valid for a native CLI backend/);
    await assert.rejects(harness.manager.create({ workspace: harness.workspace, backend: "pi", nativeResumeConversationId: UUID_B } as CreateInstanceOptions),
      /only valid for a native CLI backend/);
    for (const bad of ["latest", "", "my-session", `${UUID_B}x`, 5]) {
      await assert.rejects(harness.manager.create({ workspace: harness.workspace, backend: "claude", nativeResumeConversationId: bad } as unknown as CreateInstanceOptions),
        /exact provider conversation id/);
    }
    assert.equal(harness.manager.list().length, 0, "no row was ever posted");
    assert.equal(harness.providerCalls.length, 0, "no provider was ever asked");
  });
});

test("a restoring row keeps its admitted id until proof, refuses a wrong initial id, then follows later authoritative proof", async () => {
  await withHarness("restore", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude", nativeResumeConversationId: UUID_B } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    assert.equal(harness.providerCalls[0]?.resumeConversationId, UUID_B, "the provider receives the private intent");
    assert.equal(observer.context.resumeConversationId, UUID_B, "the observer context receives the expectation");
    assert.equal(observer.preactivation, false);
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude", conversationId: UUID_B },
      "the admitted id is retained for durable retry");
    assert.equal(JSON.stringify(harness.manager.list()).includes(UUID_B), false, "the intent never reaches a public view");

    // Before B is proved, nothing else can confirm or overwrite it, and null changes nothing.
    assert.equal(harness.manager.hasProvedNativeConversation(id), false, "the admitted id is a retry intent, not proof");
    assert.equal(observer.identity(UUID_C), false);
    assert.equal(observer.identity(null), false);
    assert.equal(observer.identity("not-a-uuid"), false);
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_B);
    assert.equal(harness.manager.hasProvedNativeConversation(id), false, "a refused identity proves nothing");

    // B itself confirms the restore.
    assert.equal(observer.identity(UUID_B), true);
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_B);
    assert.equal(harness.manager.hasProvedNativeConversation(id), true, "the run's own proof of B is the proof fact");
    assert.equal(JSON.stringify(harness.manager.list()).includes("roved"), false, "the proof fact never reaches a public view");

    // After confirmation, a later positively proved identity follows the provider.
    assert.equal(observer.identity(UUID_C), true);
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_C);
    assert.equal(observer.identity(null), true, "explicit live loss withdraws it");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "claude" });
    assert.equal(harness.manager.hasProvedNativeConversation(id), true, "a later loss does not unprove the restore itself");
  });
});

test("a restoring row whose launch ends before any proof keeps its admitted id and fabricates no confirmation", async () => {
  await withHarness("restore-unproved", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "codex", nativeResumeConversationId: UUID_B } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    harness.spawned.at(-1)!.emitExit(1);
    assert.equal(observer.identity(UUID_B), false, "an exited run cannot confirm anything");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(id), { targetId: "codex", conversationId: UUID_B });
    assert.equal(harness.manager.hasProvedNativeConversation(id), false, "an exit before proof stays unproved");
  });
});

test("without the optional observer pair, native launches are unchanged and Pi rows have no native identity", async () => {
  await withHarness("no-pair", async (harness) => {
    const fresh = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    assert.deepEqual(Object.keys(harness.providerCalls[0]!).sort(), ["env", "workspace"], "a fresh request carries nothing new");
    assert.deepEqual(harness.manager.readNativeConversationIdentity(fresh), { targetId: "claude" });
    const restored = await harness.manager.create({ workspace: harness.workspace, backend: "codex", nativeResumeConversationId: UUID_B } as CreateInstanceOptions);
    assert.equal(harness.providerCalls[1]?.resumeConversationId, UUID_B);
    assert.deepEqual(harness.manager.readNativeConversationIdentity(restored), { targetId: "codex", conversationId: UUID_B });
    assert.equal(harness.manager.readNativeConversationIdentity("no-such-row"), undefined);
    // A Pi row (whatever its synthetic launch settles as) never has a native identity.
    const pi = await harness.manager.create({ workspace: harness.workspace } as CreateInstanceOptions);
    assert.equal(harness.manager.readNativeConversationIdentity(pi), undefined);
    assert.equal(harness.manager.hasProvedNativeConversation(pi), false, "a Pi row has no native proof fact");
    assert.equal(harness.manager.hasProvedNativeConversation("no-such-row"), false);
    assert.equal(harness.manager.hasProvedNativeConversation(restored), false, "no observer, no proof");
  }, "absent");
});
