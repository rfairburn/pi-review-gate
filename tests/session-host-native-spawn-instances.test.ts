/**
 * Manager-level native SessionSpawn startup requests and routed registration
 * (issue #493).
 *
 * EVIDENCE SCOPE: every child is a synthetic PTY and every descriptor comes from
 * an injected provider. Nothing here runs a real Claude or Codex binary or
 * proves what a real provider does with the instruction. What it proves is the
 * manager contract: the provider sees only the generated instruction (plus the
 * exact Claude title), the owned file holds the exact prompt until the child's
 * actual settlement, a Codex title is the row's one stored caption with a
 * bounded published label, and routed registration is advertised only when
 * installed and fenced to the live parent.
 */

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  type InstanceManagerOptions,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeCliLaunch,
  type NativeCliLaunchRequest,
  type StatusRegistrar,
} from "../src/session-host/instances";
import { decodeNativeInitialPromptFile } from "../src/session-host/native-initial-prompt";
import { MAX_NATIVE_SESSION_NAME_LENGTH, isValidNativeDisplayName } from "../src/session-host/protocol";
import { MAX_NATIVE_DISPLAY_NAME_CHARS, type NativeCliBackend } from "../src/session-host/session-backend";

class SpyPty implements InstancePty {
  static #nextPid = 820_000;
  readonly pid: number;
  cols: number;
  rows: number;
  exited = false;
  readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  constructor(readonly spawnDescriptor: InstanceSpawnDescriptor) {
    this.pid = SpyPty.#nextPid += 1;
    this.cols = spawnDescriptor.cols;
    this.rows = spawnDescriptor.rows;
  }
  onData(): { dispose(): void } { return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose: () => { const i = this.#exitListeners.indexOf(listener); if (i >= 0) this.#exitListeners.splice(i, 1); } };
  }
  on(): void {}
  removeListener(): void {}
  write(): void {}
  resize(columns: number, rows: number): void { this.cols = columns; this.rows = rows; }
  kill(signal?: string): void { if (signal === "SIGTERM" || signal === "SIGKILL") this.emitExit(15); }
  pause(): void {}
  resume(): void {}
  emitExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.#exitListeners]) listener({ exitCode });
  }
}

class CapturingRegistrar implements StatusRegistrar {
  readonly handlers = new Map<string, InstanceStatusHandlers>();
  register(instanceId: string, handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.handlers.set(instanceId, handlers);
    return {
      bootstrap: {
        version: 1,
        socketPath: `/synthetic/${instanceId}.sock`,
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
      },
      release: () => undefined,
    };
  }
}

interface Harness {
  readonly root: string;
  readonly workspace: string;
  readonly manager: InstanceManager;
  readonly registrar: CapturingRegistrar;
  readonly spawned: SpyPty[];
  readonly calls: { backend: NativeCliBackend; request: NativeCliLaunchRequest }[];
}

function harness(
  t: { after(callback: () => void | Promise<void>): void },
  options: { provider?: NativeCliLaunch; extra?: Partial<InstanceManagerOptions> } = {},
): Harness {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".prg-native-spawn-")));
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  for (const file of ["index.js", "session-host/reporter.js", "session-host/bootstrap-preload.js"]) {
    writeFileSync(join(packageRoot, "dist", "src", file), "// Synthetic fixture; never executed.\n", "utf8");
  }
  const piExecutable = join(root, "bin", "mock-pi");
  mkdirSync(dirname(piExecutable), { recursive: true });
  writeFileSync(piExecutable, "#!/usr/bin/env node\n", "utf8");
  chmodSync(piExecutable, 0o755);
  const agentDir = join(root, "agent");
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  for (const dir of [agentDir, home, workspace]) mkdirSync(dir, { recursive: true });
  const registrar = new CapturingRegistrar();
  const spawned: SpyPty[] = [];
  const calls: Harness["calls"] = [];
  const provider: NativeCliLaunch = options.provider ?? ((backend, request) => {
    calls.push({ backend, request: { ...request, env: { ...request.env } } });
    return { file: `/synthetic/bin/${backend}`, args: [], env: { PATH: "/synthetic/bin" }, cwd: request.workspace };
  });
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, PI_CODING_AGENT_DIR: agentDir },
    args: [],
    nativeCliLaunch: provider,
    ptyFactory: (descriptor) => { const pty = new SpyPty(descriptor); spawned.push(pty); return pty; },
    ...options.extra,
  });
  t.after(async () => {
    for (const pty of spawned) pty.emitExit(0);
    await manager.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace, manager, registrar, spawned, calls };
}

function bigPrompt(): string {
  let text = "--dangerously-skip-permissions -m gpt /slash @file\n";
  while (Buffer.byteLength(text, "utf8") <= 130 * 1024) text += "ünïcödé 😀 改行\r\n\ud800";
  return `${text}end`;
}

/** The JSON-quoted staged path, extracted exactly as a native reader would. */
function stagedPath(instruction: string): string {
  const match = /"(?:[^"\\]|\\.)*"/u.exec(instruction);
  assert.ok(match, "the instruction quotes one path");
  return JSON.parse(match[0]) as string;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a Claude startup request hands the provider only the instruction and exact title; the file outlives startup until exit", async (t) => {
  const h = harness(t);
  const prompt = bigPrompt();
  const title = "  Exact Claude title, ünicode, --flag-looking ".padEnd(700, "x");
  const id = await h.manager.create({ workspace: h.workspace, backend: "claude", nativeCliTarget: "claude", initialRequest: { title, prompt } });
  assert.equal(h.calls.length, 1);
  const request = h.calls[0]!.request;
  assert.equal(request.targetId, "claude");
  assert.equal(request.initialPrompt?.title, title, "the exact title is forwarded unchanged for Claude's native option");
  const instruction = request.initialPrompt?.instruction ?? "";
  assert.ok(!JSON.stringify(request).includes("改行") && !JSON.stringify(request).includes("--dangerously"),
    "the original prompt never reaches the provider request, argv, or environment");
  const spawnedDescriptor = h.spawned[0]!.spawnDescriptor;
  assert.ok(!JSON.stringify(spawnedDescriptor).includes("改行"), "nor the spawned child's argv or environment");
  const path = stagedPath(instruction);
  assert.ok(!path.startsWith(h.workspace), "the staged file lives outside the workspace");
  assert.equal(decodeNativeInitialPromptFile(readFileSync(path, "utf8")), prompt, "the staged file decodes to the exact prompt");
  const view = h.manager.list().find((row) => row.id === id);
  assert.equal(view?.lifecycle, "alive");
  assert.equal(view?.label, "Claude", "Claude names itself natively; the host invents no caption");
  assert.equal(h.manager.readNativeConversationIdentity(id)?.caption, undefined);

  await settle();
  assert.ok(existsSync(path), "a live child (possibly still at its trust prompt) keeps the file");
  h.spawned[0]!.emitExit(0);
  await settle();
  assert.equal(existsSync(path), false, "the child's actual exit releases the owned file");
  assert.equal(existsSync(dirname(path)), false, "and its owned root");
});

test("a Codex startup title becomes the row's one stored caption with a bounded published label", async (t) => {
  const h = harness(t);
  const title = "  Codex friendly title ".padEnd(1000, "y");
  assert.ok(Buffer.byteLength(title, "utf8") <= 1024);
  const id = await h.manager.create({
    workspace: h.workspace, backend: "codex", nativeCliTarget: "codex", initialRequest: { title, prompt: "do it" },
  });
  const request = h.calls[0]!.request;
  assert.equal(request.initialPrompt?.title, undefined, "Codex has no native title option: no title argument is sent");
  assert.equal(h.manager.readNativeConversationIdentity(id)?.caption, title,
    "the full accepted title is stored exactly once, untrimmed and unclipped");
  const label = h.manager.list().find((row) => row.id === id)!.label;
  assert.notEqual(label, title, "the published label is a display projection, not the stored title");
  assert.ok(isValidNativeDisplayName(label) && Array.from(label).length <= MAX_NATIVE_SESSION_NAME_LENGTH);
  assert.ok(label.endsWith("…") && title.trim().startsWith(label.slice(0, -1)), "a shortened display is marked");

  // A short title is its own label.
  const short = await h.manager.create({
    workspace: h.workspace, backend: "codex", nativeCliTarget: "codex", initialRequest: { title: "Short", prompt: "p" },
  });
  assert.equal(h.manager.list().find((row) => row.id === short)!.label, "Short");

  // The manual rename rule is unchanged: 80 code units, never the startup bound.
  assert.equal(h.manager.setNativeDisplayName(id, "m".repeat(MAX_NATIVE_DISPLAY_NAME_CHARS + 1)), "invalid-name");
  assert.equal(h.manager.readNativeConversationIdentity(id)?.caption, title);
});

test("a remembered long caption restores whole as the caption, published through the projection", async (t) => {
  const h = harness(t);
  const caption = "Remembered startup caption ".padEnd(900, "z");
  const id = await h.manager.create({ workspace: h.workspace, backend: "codex", nativeCliTarget: "codex", label: caption });
  assert.equal(h.manager.readNativeConversationIdentity(id)?.caption, caption, "restore never drops the full caption");
  assert.ok(isValidNativeDisplayName(h.manager.list().find((row) => row.id === id)!.label));
  await assert.rejects(
    () => h.manager.create({ workspace: h.workspace, backend: "codex", label: "bad\ncaption" }),
    /caption/u,
  );
});

test("a provider failure before any child releases the owned file at once", async (t) => {
  let instruction = "";
  const h = harness(t, {
    provider: async (_backend, request) => {
      instruction = request.initialPrompt?.instruction ?? "";
      throw new Error("synthetic provider refusal");
    },
  });
  const id = await h.manager.create({
    workspace: h.workspace, backend: "claude", nativeCliTarget: "claude", initialRequest: { title: "t", prompt: "p" },
  });
  assert.equal(h.manager.list().find((row) => row.id === id)?.lifecycle, "error");
  assert.equal(h.spawned.length, 0);
  await settle();
  const path = stagedPath(instruction);
  assert.equal(existsSync(path), false, "no child of the launch can exist, so the file is released");
});

test("a startup request is refused with a resume intent or a separate label before any row exists", async (t) => {
  const h = harness(t);
  await assert.rejects(() => h.manager.create({
    workspace: h.workspace, backend: "claude", nativeCliTarget: "claude",
    nativeResumeConversationId: "0190a5c8-2b4e-7f00-8a00-000000000001", initialRequest: { title: "t", prompt: "p" },
  }), /resume/u);
  await assert.rejects(() => h.manager.create({
    workspace: h.workspace, backend: "codex", label: "caption", initialRequest: { title: "t", prompt: "p" },
  }), /no separate label/u);
  assert.deepEqual(h.manager.list(), []);
  assert.equal(h.calls.length, 0);
});

test("routed spawn is advertised only when installed and is fenced to the live current parent", async (t) => {
  const plain = harness(t);
  const plainId = await plain.manager.create({ workspace: plain.workspace });
  assert.equal(plain.registrar.handlers.get(plainId)?.onRoutedSpawnRequest, undefined,
    "a manager without a routed handler never advertises routed support");
  assert.equal(typeof plain.registrar.handlers.get(plainId)?.onSpawnRequest, "function", "the legacy route is unchanged");

  const received: { parent: string; request: unknown; current: () => boolean }[] = [];
  const routedHarness = harness(t, {
    extra: {
      onRoutedSpawnRequest: async (parent, request, current) => {
        received.push({ parent, request, current });
        return "started";
      },
    },
  });
  const parentId = await routedHarness.manager.create({ workspace: routedHarness.workspace });
  const handlers = routedHarness.registrar.handlers.get(parentId);
  assert.equal(typeof handlers?.onRoutedSpawnRequest, "function");
  const request = { workspace: "/remote", title: "t", prompt: "p", host: "lab-b", kind: "codex" as const };
  assert.equal(await handlers!.onRoutedSpawnRequest!(request), "started");
  assert.equal(received.length, 1);
  assert.equal(received[0]!.parent, parentId, "the parent id comes from the registration, never the request");
  assert.deepEqual(received[0]!.request, request, "the selectors arrive unchanged");
  assert.equal(received[0]!.current(), true);

  routedHarness.spawned[0]!.emitExit(0);
  assert.equal(received[0]!.current(), false, "an exited parent is no longer current at the write boundary");
  assert.equal(await handlers!.onRoutedSpawnRequest!(request), "failed", "and a later request is refused");
  assert.equal(received.length, 1, "without reaching the host");
});

test("SessionHosts discovery is forwarded only beside routed spawn and refuses a stale parent as unavailable", async (t) => {
  const inspect = async () => ({ ownKinds: ["pi"] as const, hosts: [] });
  // Discovery without routed spawn would describe choices the child cannot use.
  const discoveryOnly = harness(t, { extra: { onSessionHostsRequest: async () => inspect() } });
  const loneId = await discoveryOnly.manager.create({ workspace: discoveryOnly.workspace });
  assert.equal(discoveryOnly.registrar.handlers.get(loneId)?.onSessionHostsRequest, undefined,
    "discovery is never forwarded without the routed spawn handler");

  const received: { parent: string; current: () => boolean; signal: AbortSignal }[] = [];
  const both = harness(t, {
    extra: {
      onRoutedSpawnRequest: async () => "failed",
      onSessionHostsRequest: async (parent, context, current) => {
        received.push({ parent, current, signal: context.signal });
        return { ownKinds: ["pi", "codex"], hosts: [{ id: " Lab B ", label: "Lab B", kinds: ["pi"] }] };
      },
    },
  });
  const parentId = await both.manager.create({ workspace: both.workspace });
  const handlers = both.registrar.handlers.get(parentId);
  assert.equal(typeof handlers?.onSessionHostsRequest, "function");
  const signal = new AbortController().signal;
  assert.deepEqual(await handlers!.onSessionHostsRequest!({ signal }),
    { ownKinds: ["pi", "codex"], hosts: [{ id: " Lab B ", label: "Lab B", kinds: ["pi"] }] },
    "the host's snapshot is relayed unchanged, raw ids included");
  assert.equal(received.length, 1);
  assert.equal(received[0]!.parent, parentId, "the parent id comes from the registration");
  assert.equal(received[0]!.signal, signal, "the broker's abort signal reaches the host");
  assert.equal(received[0]!.current(), true);

  both.spawned[0]!.emitExit(0);
  assert.equal(received[0]!.current(), false, "an exited parent is no longer current");
  await assert.rejects(() => handlers!.onSessionHostsRequest!({ signal }),
    "a stale parent is an unavailable inspection, never an empty listing");
  assert.equal(received.length, 1, "without reaching the host");
});
