import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InstanceManager,
  __test as instanceTestSeam,
  createDefaultPtyFactory,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeInstanceView,
  type StatusRegistrar,
} from "../src/session-host/instances";
import type { NativeLaunchDescriptor } from "../src/session-host/launch";

/**
 * The Windows batch delivery contract, checked where it can be checked without
 * a Windows host (issue #277, native Windows slice).
 *
 * The pinned `@lydell/node-pty` Windows spawn has exactly two public ways to
 * receive a child: an argv array, which it escapes itself per the MSDN
 * command-line rules, or one pre-escaped command-line string appended verbatim
 * after the program path. A `.cmd`/`.bat` CLI shim needs the outer quotes of
 * `cmd.exe /d /s /c "<command line>"` to survive verbatim, because cmd.exe does
 * not treat a backslash as an escape — so an argv array cannot carry it. What
 * cmd.exe actually does with the result is proven natively in
 * `session-host-native-cli-windows-pty.test.ts`; what this file proves is the
 * wiring that makes that native outcome possible at all: the batch descriptor's
 * command line is the one argument value the pinned public spawn receives, an
 * argv child still receives its argv, and a malformed command line is refused
 * instead of being dropped or spawned as a bare interpreter.
 *
 * No real process is spawned here and no platform-specific behavior is
 * simulated inside production code: the platform read is the same
 * `process.platform` seam the existing factory regressions use, and the pinned
 * module itself is replaced by a recording loader for these cases only.
 */

const BATCH_COMMAND_LINE = `/d /s /c "C:\\fixture\\npm shims\\codex.cmd" --no-daemon`;

interface RecordedSpawn {
  readonly file: string;
  readonly args: unknown;
  readonly options: Record<string, unknown>;
}

/** A never-exercised PTY surface that reports exit when its owner kills it. */
function makeFakePty(): InstancePty {
  const exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
  let exited = false;
  const settle = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode });
  };
  const pty: InstancePty = {
    pid: 4242,
    cols: 80,
    rows: 24,
    onData: () => ({ dispose: () => undefined }),
    onExit: (listener) => {
      exitListeners.push(listener);
      return { dispose: () => undefined };
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => settle(1),
    pause: () => undefined,
    resume: () => undefined,
  };
  return pty;
}

class SilentRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(instanceId: string, _handlers: InstanceStatusHandlers): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: { version: 1, socketPath: join(tmpdir(), `prg-win-delivery-${instanceId}.sock`), token: "t", instanceId, generation: "g" },
      release: () => undefined,
    };
  }
}

function viewOf(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, "the row exists");
  return view;
}

/** Run `body` with `process.platform` reported as `platform`, then restore it. */
function withPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(original, "process.platform is describable");
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try {
    return body();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("the default PTY factory gives the pinned public spawn a batch child's pre-escaped command line instead of an argv array", () => {
  let spawns: RecordedSpawn[] = [];
  const ownedPty = {} as unknown as import("@lydell/node-pty").IPty;
  instanceTestSeam.setNodePtyLoaderForTests(() => ({
    spawn(file: string, args: string[] | string, options: Record<string, unknown>) {
      spawns.push({ file, args, options });
      return ownedPty;
    },
  }));
  const factory = createDefaultPtyFactory();
  const base = { env: { PATH: "C:\\fixture" }, cwd: "C:\\fixture\\workspace", cols: 80, rows: 24 };
  try {
    withPlatform("win32", () => {
      const batch: InstanceSpawnDescriptor = {
        file: "C:\\Windows\\System32\\cmd.exe",
        args: [],
        commandLine: BATCH_COMMAND_LINE,
        ...base,
      };
      assert.equal(factory(batch), ownedPty, "the exact public PTY handle returns to its owner");
      assert.equal(spawns.length, 1);
      const [batchSpawn] = spawns;
      assert.ok(batchSpawn);
      assert.equal(batchSpawn.file, batch.file);
      assert.equal(typeof batchSpawn.args, "string",
        "the pinned Windows spawn receives the batch invocation as its public pre-escaped command line, not as argv");
      assert.equal(batchSpawn.args, BATCH_COMMAND_LINE, "the command line reaches the pinned spawn verbatim, unquoted and unescaped");
      assert.equal((batchSpawn.options as { useConptyDll?: unknown }).useConptyDll, true,
        "the batch child still runs on the ConPTY DLL bundled with the pinned platform package");
      assert.equal(Object.hasOwn(batchSpawn.options, "useConpty"), false, "the deprecated ignored useConpty hint is never set");

      const direct: InstanceSpawnDescriptor = {
        file: "C:\\fixture\\npm shims\\claude.exe",
        args: ["--profile", "host profile"],
        ...base,
      };
      spawns = [];
      factory(direct);
      const [directSpawn] = spawns;
      assert.ok(directSpawn);
      assert.deepEqual(directSpawn.args, ["--profile", "host profile"],
        "a direct executable keeps the argv form, which the pinned spawn escapes correctly");
      assert.equal(Object.hasOwn(directSpawn.options, "commandLine"), false,
        "the command line is a spawn argument, never an invented option");
    });

    withPlatform("linux", () => {
      spawns = [];
      factory({ file: "/usr/local/bin/claude", args: ["--profile", "host profile"], env: { PATH: "/usr/local/bin" }, cwd: "/srv/workspace", cols: 80, rows: 24 });
      const [posixSpawn] = spawns;
      assert.ok(posixSpawn);
      assert.deepEqual(posixSpawn.args, ["--profile", "host profile"], "POSIX children keep the unchanged argv path");
      assert.equal(Object.hasOwn(posixSpawn.options, "useConptyDll"), false, "POSIX spawn options stay unchanged");
    });
  } finally {
    instanceTestSeam.setNodePtyLoaderForTests(undefined);
  }
});

test("the manager carries one native row's Windows command line from the launch provider to its PTY factory verbatim", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-native-cli-win-delivery-")));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const seen: InstanceSpawnDescriptor[] = [];
    const registrar = new SilentRegistrar();
    const manager = new InstanceManager({
      packageRoot: root,
      piExecutable: "C:\\fixture\\pi.cmd",
      statusRegistrar: registrar,
      env: {},
      args: [],
      nativeCliLaunch: async (backend, request): Promise<NativeLaunchDescriptor> => backend === "codex"
        ? { file: "C:\\Windows\\System32\\cmd.exe", args: [], commandLine: BATCH_COMMAND_LINE, env: {}, cwd: request.workspace }
        : { file: "C:\\fixture\\npm shims\\claude.exe", args: ["--profile", "host profile"], env: {}, cwd: request.workspace },
      ptyFactory: (descriptor) => {
        seen.push(descriptor);
        return makeFakePty();
      },
    });

    const codexId = await manager.create({ workspace, backend: "codex" });
    const claudeId = await manager.create({ workspace, backend: "claude" });

    assert.equal(seen.length, 2, "both rows reached the PTY factory");
    const [codexSpawn, claudeSpawn] = seen;
    assert.ok(codexSpawn && claudeSpawn);
    assert.equal(codexSpawn.commandLine, BATCH_COMMAND_LINE, "the batch row's command line survives validation unchanged");
    assert.deepEqual(codexSpawn.args, [], "the batch row carries no argv for the pinned spawn to re-escape");
    assert.equal(codexSpawn.cwd, realpathSync(workspace), "the batch row still runs in its own selected workspace");
    assert.equal(claudeSpawn.commandLine, undefined, "a direct-executable row is given no command line");
    assert.deepEqual(claudeSpawn.args, ["--profile", "host profile"], "the direct row's argv is unchanged");
    assert.deepEqual(registrar.requests, [], "a provider row is never registered with the status broker");

    const shutdown = await manager.shutdown({ graceMs: 250, killMs: 250 });
    assert.deepEqual(shutdown.remainingIds, [], "both owned handles settled");
    void codexId;
    void claudeId;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unusable Windows command line on a native launch descriptor is refused before any child exists", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-native-cli-win-delivery-refuse-")));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const cases: Array<{ readonly label: string; readonly commandLine: unknown }> = [
      { label: "empty", commandLine: "" },
      { label: "control character", commandLine: `/d /s /c "C:\\fixture\\claude.cmd\u0007"` },
      { label: "newline", commandLine: `/d /s /c "C:\\fixture\\claude.cmd"\r\nextra` },
      { label: "non-string", commandLine: 42 },
    ];
    for (const testCase of cases) {
      const seen: InstanceSpawnDescriptor[] = [];
      const manager = new InstanceManager({
        packageRoot: root,
        piExecutable: "C:\\fixture\\pi.cmd",
        statusRegistrar: new SilentRegistrar(),
        env: {},
        args: [],
        nativeCliLaunch: async (_backend, request): Promise<NativeLaunchDescriptor> => ({
          file: "C:\\Windows\\System32\\cmd.exe",
          args: [],
          commandLine: testCase.commandLine as string,
          env: {},
          cwd: request.workspace,
        }),
        ptyFactory: (descriptor) => {
          seen.push(descriptor);
          return makeFakePty();
        },
      });
      const id = await manager.create({ workspace, backend: "codex" });
      const view = viewOf(manager, id);
      assert.equal(view.lifecycle, "error", `${testCase.label}: a malformed command line is reported, never left pending`);
      assert.equal(view.hasLiveProcess, false, `${testCase.label}: a refused launch owns no process`);
      assert.ok(view.error, `${testCase.label}: the row carries a bounded public failure`);
      assert.equal(seen.length, 0, `${testCase.label}: no child is spawned from an unusable command line`);
      assert.equal(manager.surface(id), undefined, `${testCase.label}: no terminal surface exists for a child that never spawned`);
      await manager.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
