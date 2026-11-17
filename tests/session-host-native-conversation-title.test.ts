/**
 * Focused component coverage for the EPHEMERAL provider conversation TITLE lane in
 * `InstanceManager` (issue #690).
 *
 * EVIDENCE SCOPE: synthetic PTYs, an injected test launch provider, a synthetic
 * registrar shaped like the broker's `registerNativeHookSource`, and a synthetic
 * observer that only calls the owner-private channels it was handed. Nothing here
 * runs a real Claude or Codex binary, reads provider state, or proves that a real
 * provider emits any particular title field; the provider-side semantics are pinned
 * in the Claude acquisition, Codex RPC, Codex status, and owned-status suites. What
 * this file pins is the manager's side of the settled contract: precedence, the
 * manual-intent latch, attribution, ephemerality, and the fact that no new field,
 * persistence, or provider write appears anywhere.
 */

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
import type { NativeCliBackend } from "../src/session-host/session-backend";
import { MAX_NATIVE_DISPLAY_NAME_CHARS } from "../src/session-host/session-backend";
import { MAX_NATIVE_SESSION_NAME_LENGTH } from "../src/session-host/protocol";
import type { NativeHookSourceHandlers } from "../src/session-host/broker";

const UUID_B = "1d6f2b9e-3c4a-4e5f-9a0b-1c2d3e4f5a6b";
const UUID_C = "8e7d6c5b-4a39-4281-b7c6-d5e4f3a2b1c0";
const TITLE = "Investigate the flaky census";

class SpyPty implements InstancePty {
  static #nextPid = 960_000;
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
  preactivationIdentity: boolean | undefined;
  preactivationTitle: boolean | undefined;
  constructor(readonly context: NativeStatusObserverContext) {}
  acceptHook(): void { /* unused */ }
  acceptFailure(): void { /* unused */ }
  dispose(): void { /* unused */ }
  identity(value: string | null): boolean {
    const emit = this.context.emitConversationIdentity;
    assert.ok(emit, "the production manager always supplies the identity channel");
    return emit(value);
  }
  title(conversationId: string, title: string | null): boolean {
    const emit = this.context.emitConversationTitle;
    assert.ok(emit, "the production manager always supplies the title channel");
    return emit(conversationId, title);
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

function makeHarness(label: string): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-native-title-${label}-`)));
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
      return {
        file: `/synthetic/bin/${backend}`,
        args: ["--interactive"],
        env: { PATH: "/synthetic/bin", HOME: home },
        cwd: request.workspace,
      };
    },
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
          release: () => {
            handlers.delete(instanceId);
          },
        };
      },
    } satisfies NativeHookSourceRegistrar,
    nativeStatusObserverFactory: (context: NativeStatusObserverContext) => {
      const observer = new SpyObserver(context);
      // Before the run's capture exists, neither private channel claims anything.
      observer.preactivationIdentity = context.emitConversationIdentity?.(UUID_B);
      observer.preactivationTitle = context.emitConversationTitle?.(UUID_B, TITLE);
      observers.push(observer);
      return observer;
    },
    ptyFactory: (descriptor) => {
      const pty = new SpyPty(descriptor);
      spawned.push(pty);
      return pty;
    },
  });
  return { root, workspace, manager, observers, spawned, providerCalls, changes };
}

async function withHarness(label: string, body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = makeHarness(label);
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

function labelOf(harness: Harness, id: string): string | undefined {
  return harness.manager.list().find((row) => row.id === id)?.label;
}

function changesFor(harness: Harness, id: string): number {
  return harness.changes.filter((changed) => changed === id).length;
}

/** Prove the row's conversation, then offer it its provider title. */
function adopt(observer: SpyObserver, conversationId = UUID_B, title = TITLE): boolean {
  assert.equal(observer.identity(conversationId), true);
  return observer.title(conversationId, title);
}

test("a proved provider title becomes the row's one published label, and never a new field", async () => {
  await withHarness("acquire", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    assert.equal(observer.preactivationIdentity, false, "a preactivation identity claims nothing");
    assert.equal(observer.preactivationTitle, false, "a preactivation title claims nothing");
    assert.equal(labelOf(harness, id), "Claude", "the provider label stands until the provider speaks");

    const before = changesFor(harness, id);
    assert.equal(observer.identity(UUID_B), true, "the identity publishes its own change");
    assert.equal(changesFor(harness, id), before + 1);
    assert.equal(observer.title(UUID_B, TITLE), true, "the title publishes its own change");
    assert.equal(labelOf(harness, id), TITLE, "the automatic title is the row's effective label");
    assert.equal(changesFor(harness, id), before + 2, "the ordinary change path publishes it");

    // A repeat is accepted but changes nothing; a rename updates the row.
    assert.equal(observer.title(UUID_B, TITLE), true);
    assert.equal(changesFor(harness, id), before + 2, "an unchanged title publishes nothing");
    assert.equal(observer.title(UUID_B, "Investigate the flaky census, take two"), true);
    assert.equal(labelOf(harness, id), "Investigate the flaky census, take two");

    // Nothing new is published: the view's field set is exactly what it was, and the
    // title is only ever in the ONE label field.
    const view = harness.manager.list().find((row) => row.id === id)!;
    assert.equal(Object.hasOwn(view, "nativeTitle"), false);
    assert.equal(Object.hasOwn(view, "conversationTitle"), false);
    assert.equal(Object.hasOwn(view, "caption"), false);
    assert.equal(view.nativeSession, null, "a provider title never becomes a Pi native tuple");
    assert.equal(JSON.stringify(harness.manager.nativeStatusCapture(id)).includes(TITLE), false,
      "a title never rides a status capture");

    // An explicit withdrawal returns the row to the provider default.
    assert.equal(observer.title(UUID_B, null), true);
    assert.equal(labelOf(harness, id), "Claude");
    assert.equal(observer.title(UUID_B, null), false, "nothing is held to withdraw");
  });
});

test("attribution: a title belongs only to this row's current proved conversation", async () => {
  await withHarness("attribution", async (harness) => {
    const first = await harness.manager.create({ workspace: harness.workspace, backend: "codex", nativeCliTarget: "codex-work" } as CreateInstanceOptions);
    const firstObserver = lastObserver(harness);
    const second = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const secondObserver = lastObserver(harness);

    // No proved conversation yet: a title claims nothing at all.
    assert.equal(secondObserver.title(UUID_B, TITLE), false, "an unproved conversation cannot carry a title");
    assert.equal(labelOf(harness, second), "Claude");

    assert.equal(firstObserver.identity(UUID_B), true);
    assert.equal(firstObserver.title(UUID_B, TITLE), true);
    assert.equal(labelOf(harness, first), TITLE);
    assert.equal(labelOf(harness, second), "Claude", "one row's title never touches another row");

    // A title for a conversation this row does not have is refused.
    assert.equal(firstObserver.title(UUID_C, "Someone else's conversation"), false);
    assert.equal(labelOf(harness, first), TITLE);

    // A genuine rebind withdraws the previous conversation's title, and only the new
    // conversation's own title can name the row again.
    assert.equal(firstObserver.identity(UUID_C), true);
    assert.equal(labelOf(harness, first), "Codex", "the retired conversation's title is gone, not carried over");
    assert.equal(firstObserver.title(UUID_C, "Now it is this conversation"), true);
    assert.equal(labelOf(harness, first), "Now it is this conversation");

    // An explicit live identity loss clears the title the same way.
    assert.equal(firstObserver.identity(null), true);
    assert.equal(labelOf(harness, first), "Codex");
    assert.equal(firstObserver.title(UUID_C, "Stale after loss"), false, "no live proof, no title");
  });
});

test("staleness: a retired generation, a stopped run, or an exited row cannot write or clear a title", async () => {
  await withHarness("staleness", async (harness) => {
    const live = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const liveObserver = lastObserver(harness);
    adopt(liveObserver);
    assert.equal(labelOf(harness, live), TITLE);

    // Accepted invalidation loses the generation: its last title is withdrawn, and
    // its later callbacks claim nothing.
    const capture = harness.manager.nativeStatusCapture(live);
    assert.ok(capture);
    assert.equal(capture.invalidate().accepted, true);
    assert.equal(labelOf(harness, live), "Claude", "a lost generation cannot keep naming the row");
    assert.equal(liveObserver.title(UUID_B, "From a retired generation"), false);
    assert.equal(liveObserver.title(UUID_B, null), false, "a retired generation cannot withdraw either");
    assert.equal(labelOf(harness, live), "Claude");

    // A confirmed stop retires the run: no title can arrive afterwards.
    const stopped = await harness.manager.create({ workspace: harness.workspace, backend: "codex" } as CreateInstanceOptions);
    const stoppedObserver = lastObserver(harness);
    adopt(stoppedObserver);
    assert.equal(labelOf(harness, stopped), TITLE);
    const result = await harness.manager.stop(stopped, { confirmed: true });
    assert.equal(result.status, "exited");
    assert.equal(stoppedObserver.title(UUID_B, "After the stop"), false);
    assert.equal(stoppedObserver.title(UUID_B, null), false);

    // An exited row answers with what it has; nothing new is written to it.
    const exited = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const exitedObserver = lastObserver(harness);
    adopt(exitedObserver);
    harness.spawned.at(-1)!.emitExit(0);
    assert.equal(exitedObserver.title(UUID_B, "After the exit"), false);
  });
});

test("manual captions outrank a provider title in every order, including an equal one", async () => {
  await withHarness("precedence", async (harness) => {
    // Caption first: the provider can never move the row again.
    const first = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const firstObserver = lastObserver(harness);
    assert.equal(harness.manager.setNativeDisplayName(first, "My review box"), "set");
    assert.equal(labelOf(harness, first), "My review box");
    assert.equal(adopt(firstObserver), false, "a captioned row refuses the provider title");
    assert.equal(labelOf(harness, first), "My review box", "a caption outranks the provider");

    // Caption after an automatic title: the caption wins and latches.
    const second = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const secondObserver = lastObserver(harness);
    adopt(secondObserver);
    assert.equal(labelOf(harness, second), TITLE);
    assert.equal(harness.manager.setNativeDisplayName(second, "Hand named"), "set");
    assert.equal(labelOf(harness, second), "Hand named");
    assert.equal(secondObserver.title(UUID_B, "A later provider title"), false,
      "an accepted caption ends the automatic lane for this row");
    assert.equal(labelOf(harness, second), "Hand named");

    // EQUAL to the automatic title: still "unchanged", and STILL a latched caption.
    const equal = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const equalObserver = lastObserver(harness);
    adopt(equalObserver);
    assert.equal(labelOf(harness, equal), TITLE);
    assert.equal(harness.manager.setNativeDisplayName(equal, TITLE), "unchanged",
      "the text really was already equal");
    assert.equal(equalObserver.title(UUID_B, "A different provider title"), false,
      "the equal caption established manual intent, not a no-op");
    assert.equal(labelOf(harness, equal), TITLE);

    // EQUAL to the provider default: a valid, durable opt-out that latches too.
    const defaulted = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const defaultedObserver = lastObserver(harness);
    assert.equal(harness.manager.setNativeDisplayName(defaulted, "Claude"), "unchanged");
    assert.equal(defaultedObserver.title(UUID_B, TITLE), false, "captioning with the default is still opt-out");
    assert.equal(labelOf(harness, defaulted), "Claude");

    // A configured (restored) initial label is a caption from the start.
    const restored = await harness.manager.create({
      workspace: harness.workspace,
      backend: "codex",
      label: "Restored caption",
    } as CreateInstanceOptions);
    const restoredObserver = lastObserver(harness);
    assert.equal(labelOf(harness, restored), "Restored caption");
    assert.equal(adopt(restoredObserver), false, "a configured caption is manual intent from the start");
    assert.equal(labelOf(harness, restored), "Restored caption");
  });
});

test("validation: an unusable automatic title is refused whole, never clipped, and never reaches a Pi row", async () => {
  await withHarness("validation", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    assert.equal(observer.identity(UUID_B), true);

    for (const unusable of ["", "   ", " padded ", "two\nlines", "a\ttab", `nul\u0000`,
      "x".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 1)]) {
      assert.equal(observer.title(UUID_B, unusable), false, `${JSON.stringify(unusable.slice(0, 12))}… is refused`);
      assert.equal(labelOf(harness, id), "Claude", `nothing was written by ${JSON.stringify(unusable.slice(0, 12))}…`);
    }
    assert.equal(observer.title(UUID_B, TITLE), true);
    assert.equal(labelOf(harness, id), TITLE);

    // A malformed conversation id is refused the same way.
    assert.equal(observer.title("latest", "Foreign"), false);
    assert.equal(observer.title(`${UUID_B}x`, "Foreign"), false);

    // The manual path keeps its own closed vocabulary, and a Pi row keeps its rename
    // path: neither is reachable through the title lane.
    assert.equal(harness.manager.setNativeDisplayName(id, ""), "invalid-name");
    assert.equal(labelOf(harness, id), TITLE);
    const pi = await harness.manager.create({ workspace: harness.workspace } as CreateInstanceOptions);
    assert.equal(harness.manager.setNativeDisplayName(pi, "Not a native row"), "not-native");
    assert.equal(harness.manager.readNativeConversationIdentity(pi), undefined,
      "a Pi row has no native identity, and so no title subject either");
    assert.equal(harness.manager.list().find((row) => row.id === pi)?.label, "(session starting)");
  });
});

test("an automatic title is measured by the published-label bound, never by the manual caption's", async () => {
  await withHarness("bounds", async (harness) => {
    assert.ok(MAX_NATIVE_DISPLAY_NAME_CHARS < MAX_NATIVE_SESSION_NAME_LENGTH,
      "the manual caption bound really is the narrower of the two");

    // A provider title LONGER than the operator's own caption bound is ordinary
    // display text this host must be able to show: it publishes whole.
    const long = `Investigating why the census read raced the ${"generation".repeat(6)} boundary`;
    assert.ok(long.length > MAX_NATIVE_DISPLAY_NAME_CHARS, `the fixture really is over the caption bound: ${long.length}`);
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    assert.equal(observer.identity(UUID_B), true);
    assert.equal(observer.title(UUID_B, long), true, "a valid provider title is never discarded for its length");
    assert.equal(labelOf(harness, id), long, "and it publishes whole, unclipped");

    // The same text as a MANUAL caption is still refused: the operator's input bound
    // is unchanged, and this is not a way around it.
    assert.equal(harness.manager.setNativeDisplayName(id, long), "invalid-name");
    assert.equal(labelOf(harness, id), long, "a refused caption changes nothing");

    // What the published label cannot carry is refused whole: a row's label travels
    // to a peer under the canonical native-name bound, and a title that could not
    // survive that trip is never half-published.
    assert.equal(observer.title(UUID_B, "y".repeat(MAX_NATIVE_SESSION_NAME_LENGTH + 1)), false);
    assert.equal(labelOf(harness, id), long);
    assert.equal(observer.title(UUID_B, "y".repeat(MAX_NATIVE_SESSION_NAME_LENGTH)), true,
      "the canonical bound itself is inclusive");
    assert.equal(labelOf(harness, id), "y".repeat(MAX_NATIVE_SESSION_NAME_LENGTH));

    // Non-ASCII is measured the same way the published label measures it: code points,
    // not UTF-16 units, so a title with astral and accented text is not refused for nothing.
    const glyph = String.fromCodePoint(0x1f524); // one code point, two UTF-16 units
    const accented = String.fromCodePoint(0xe9);
    const emoji = `${glyph} ${accented.repeat(MAX_NATIVE_SESSION_NAME_LENGTH - 3)}${glyph}`;
    assert.equal(Array.from(emoji).length, MAX_NATIVE_SESSION_NAME_LENGTH, "exactly the bound in code points");
    assert.ok(emoji.length > MAX_NATIVE_SESSION_NAME_LENGTH, "while its UTF-16 length is already over it");
    assert.equal(observer.title(UUID_B, emoji), true);
    assert.equal(labelOf(harness, id), emoji);
  });
});

test("a manual caption survives later provider renames and a conversation reset", async () => {
  await withHarness("latch", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude" } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    assert.equal(adopt(observer), true);
    assert.equal(labelOf(harness, id), TITLE, "before the edit, the provider's title names the row");

    assert.equal(harness.manager.setNativeDisplayName(id, "Kept by hand"), "set");
    assert.equal(labelOf(harness, id), "Kept by hand");

    // A later provider rename of the SAME conversation cannot move a captioned row.
    assert.equal(observer.title(UUID_B, "Renamed again by the provider"), false);
    assert.equal(labelOf(harness, id), "Kept by hand");

    // A genuine conversation reset or rebind keeps the caption: it belongs to the row,
    // not to one conversation, and the new conversation's title is refused too.
    assert.equal(observer.identity(UUID_C), true);
    assert.equal(labelOf(harness, id), "Kept by hand");
    assert.equal(observer.title(UUID_C, "The new conversation's own title"), false);
    assert.equal(labelOf(harness, id), "Kept by hand");

    // A live identity loss and a fresh proof change nothing either.
    assert.equal(observer.identity(null), true);
    assert.equal(observer.identity(UUID_C), true);
    assert.equal(labelOf(harness, id), "Kept by hand");
    assert.equal(observer.title(UUID_C, "Still refused"), false);
    assert.equal(labelOf(harness, id), "Kept by hand");
  });
});

test("ephemerality: an automatic title never reaches the restart identity or any persisted field", async () => {
  await withHarness("ephemeral", async (harness) => {
    const id = await harness.manager.create({ workspace: harness.workspace, backend: "claude", nativeCliTarget: "claude-a" } as CreateInstanceOptions);
    const observer = lastObserver(harness);
    adopt(observer);
    assert.equal(labelOf(harness, id), TITLE);

    // The only owner read is the restart identity, and it carries no title.
    const restart = harness.manager.readNativeConversationIdentity(id);
    assert.deepEqual(restart, { targetId: "claude-a", conversationId: UUID_B });
    assert.equal(JSON.stringify(restart).includes(TITLE), false);

    // The row survives its own exit with its restart identity; the automatic title is
    // not restorable state, so nothing about it is remembered anywhere the manager
    // exposes. The exited row's label keeps what it last showed, and no channel can
    // write a new one.
    harness.spawned.at(-1)!.emitExit(0);
    assert.equal(harness.manager.readNativeConversationIdentity(id)?.conversationId, UUID_B);
    assert.equal(observer.title(UUID_B, "After the exit"), false);
    assert.doesNotMatch(JSON.stringify(harness.manager.list()), /nativeTitle|conversationTitle|autoTitle/);
  });
});
