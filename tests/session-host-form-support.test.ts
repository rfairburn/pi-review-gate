import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";

import { EXECUTOR_TOOL_CATALOG_ENV, RUNTIME_ROLE_ENV, SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { loadNativeFieldKeybindings, runNativeExternalEditor } from "../src/session-host/form-support";

const FORM_TEST_SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-form-support-tests");

function makeFormTestDirectory(prefix: string): string {
  mkdirSync(FORM_TEST_SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(FORM_TEST_SCRATCH_ROOT, `${prefix}-`));
}

test("native app clear/interruption bindings reload per field without changing native TUI bindings", () => {
  const root = makeFormTestDirectory("field-keys");
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const defaults = loadNativeFieldKeybindings(join(root, "missing-agent"));
    assert.equal(defaults.manager.matches("\x03", "app.clear"), true, "app.clear defaults to Ctrl+C");
    assert.equal(defaults.manager.matches("\x1b", "app.interrupt"), true, "app.interrupt defaults to Escape");
    const path = join(agentDir, "keybindings.json");
    const contents = JSON.stringify({
      "tui.input.submit": "f5",
      "app.clear": "ctrl+l",
      "app.interrupt": "ctrl+x",
      "app.editor.external": "alt+g",
    });
    writeFileSync(path, contents, "utf8");
    const loaded = loadNativeFieldKeybindings(agentDir);
    assert.equal(loaded.notice, undefined);
    assert.equal(loaded.manager.matches("\x1b[15~", "tui.input.submit"), true);
    assert.equal(loaded.manager.matches("\r", "tui.input.submit"), false);
    assert.equal(loaded.manager.matches("\x0c", "app.clear"), true);
    assert.equal(loaded.manager.matches("\x18", "app.interrupt"), true);
    assert.equal(loaded.manager.matches("\x03", "app.clear"), false);
    assert.equal(loaded.manager.matches("\x1b", "app.interrupt"), false);
    assert.equal(loaded.manager.matches("\x1b", "tui.select.cancel"), true, "native TUI editing bindings remain intact");
    assert.equal(readFileSync(path, "utf8"), contents);

    writeFileSync(path, JSON.stringify({ "app.clear": "ctrl+u", "app.interrupt": "ctrl+z" }), "utf8");
    const reopened = loadNativeFieldKeybindings(agentDir);
    assert.equal(reopened.manager.matches("\x15", "app.clear"), true);
    assert.equal(reopened.manager.matches("\x1a", "app.interrupt"), true);
    assert.equal(reopened.manager.matches("\x0c", "app.clear"), false);
    assert.equal(loaded.manager.matches("\x0c", "app.clear"), true, "an open field keeps its original keybinding snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external editor uses a private bounded file, shell-free owned child, and preserves runtime role/catalog", async () => {
  const root = makeFormTestDirectory("external-editor");
  const edited = "replacement title";
  let spawnedFile = "";
  let spawnedCommand = "";
  let spawnedArgs: string[] = [];
  let spawnedOptions: SpawnOptions | undefined;
  try {
    const fakeSpawn = ((command: string, args: string[], options: SpawnOptions) => {
      spawnedCommand = command;
      spawnedArgs = [...args];
      spawnedOptions = options;
      spawnedFile = args.at(-1) ?? "";
      assert.equal(readFileSync(spawnedFile, "utf8"), "original title");
      assert.equal(lstatSync(spawnedFile).mode & 0o777, 0o600, "the private edit file is owner-only");
      writeFileSync(spawnedFile, edited, "utf8");
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 12345, exitCode: null, signalCode: null, killed: false, kill: () => true });
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const env: NodeJS.ProcessEnv = {
      VISUAL: "synthetic-editor --wait",
      EDITOR: "ignored-editor",
      [RUNTIME_ROLE_ENV]: "executor",
      [EXECUTOR_TOOL_CATALOG_ENV]: "private-catalog",
      [SESSION_HOST_BOOTSTRAP_ENV]: "private-token",
    };
    const result = await runNativeExternalEditor("original title", {
      env,
      cwd: root,
      tempRoot: root,
      spawn: fakeSpawn,
    });
    assert.equal(result, edited);
    assert.equal(spawnedCommand, "synthetic-editor");
    assert.deepEqual(spawnedArgs.slice(0, -1), ["--wait"]);
    assert.ok(spawnedFile.startsWith(join(root, ".pi-review-sessions-editor-")));
    assert.equal(spawnedOptions?.shell, false);
    assert.deepEqual(spawnedOptions?.stdio, "inherit");
    assert.equal(spawnedOptions?.env?.[RUNTIME_ROLE_ENV], "executor");
    assert.equal(spawnedOptions?.env?.[EXECUTOR_TOOL_CATALOG_ENV], "private-catalog");
    assert.equal(spawnedOptions?.env?.[SESSION_HOST_BOOTSTRAP_ENV], undefined);
    assert.deepEqual(readdirSync(root), [], "the owned temporary directory is removed after completion");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external editor removes one final line terminator but preserves meaningful spaces and multiline data", async () => {
  const root = makeFormTestDirectory("external-editor-lines");
  try {
    const runWithResult = async (result: string): Promise<string> => {
      const fakeSpawn = ((_command: string, args: string[]) => {
        writeFileSync(args.at(-1)!, result, "utf8");
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { pid: 12348, exitCode: null, signalCode: null, killed: false, kill: () => true });
        queueMicrotask(() => {
          child.emit("spawn");
          child.emit("close", 0, null);
        });
        return child;
      }) as unknown as typeof import("node:child_process").spawn;
      return runNativeExternalEditor("initial", {
        env: { EDITOR: "synthetic-editor" },
        cwd: root,
        tempRoot: root,
        spawn: fakeSpawn,
      });
    };

    assert.equal(await runWithResult("  title with spaces  \r\n"), "  title with spaces  ");
    assert.equal(await runWithResult("first\nsecond\n"), "first\nsecond", "only one conventional terminal newline is removed");
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external editor cleanup preserves a replaced symlink and its target", async () => {
  const root = makeFormTestDirectory("external-editor-replaced");
  const target = join(root, "user-file.txt");
  let replacedPath = "";
  try {
    writeFileSync(target, "preserve this file", "utf8");
    const fakeSpawn = ((command: string, args: string[]) => {
      assert.equal(command, "synthetic-editor");
      replacedPath = args.at(-1) ?? "";
      const original = readFileSync(replacedPath, "utf8");
      assert.equal(original, "original");
      rmSync(replacedPath);
      symlinkSync(target, replacedPath);
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 12346, exitCode: null, signalCode: null, killed: false, kill: () => true });
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(runNativeExternalEditor("original", {
      env: { EDITOR: "synthetic-editor" },
      cwd: root,
      tempRoot: root,
      spawn: fakeSpawn,
    }), /temporary file was replaced/);
    assert.equal(readFileSync(target, "utf8"), "preserve this file");
    assert.equal(lstatSync(replacedPath).isSymbolicLink(), true, "cleanup does not unlink a substituted path by name");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external editor rejects a replaced temporary directory without touching its symlink target", async () => {
  const root = makeFormTestDirectory("external-editor-directory-replaced");
  const target = join(root, "unrelated-directory");
  const movedDirectory = join(root, "moved-owned-directory");
  let replacedDirectory = "";
  try {
    mkdirSync(target);
    writeFileSync(join(target, "field.txt"), "preserve this unrelated field", "utf8");
    const fakeSpawn = ((_command: string, args: string[]) => {
      replacedDirectory = join(args.at(-1)!, "..");
      const normalizedDirectory = join(replacedDirectory);
      assert.equal(readFileSync(args.at(-1)!, "utf8"), "original");
      renameSync(normalizedDirectory, movedDirectory);
      symlinkSync(target, normalizedDirectory);
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 12349, exitCode: null, signalCode: null, killed: false, kill: () => true });
      queueMicrotask(() => {
        child.emit("spawn");
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(runNativeExternalEditor("original", {
      env: { EDITOR: "synthetic-editor" },
      cwd: root,
      tempRoot: root,
      spawn: fakeSpawn,
    }), /temporary directory was replaced/);
    assert.equal(readFileSync(join(target, "field.txt"), "utf8"), "preserve this unrelated field");
    assert.equal(lstatSync(replacedDirectory).isSymbolicLink(), true, "the replaced directory entry is not removed by name");
    assert.deepEqual(readdirSync(movedDirectory), ["field.txt"], "uncertain cleanup leaves the moved original entry rather than following the replacement");
    assert.equal(readFileSync(join(movedDirectory, "field.txt"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborting the external-editor handoff escalates only its owned child", async () => {
  const root = makeFormTestDirectory("external-editor-abort");
  const controller = new AbortController();
  const calls: string[] = [];
  let child: ChildProcess | undefined;
  let signalSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { signalSpawned = resolve; });
  try {
    const fakeSpawn = (() => {
      const ownedChild = new EventEmitter() as ChildProcess;
      child = ownedChild;
      Object.assign(ownedChild, {
        pid: 12347,
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: (signal?: string) => {
          calls.push(signal ?? "default");
          if (signal === "SIGKILL") {
            Object.assign(ownedChild, { signalCode: "SIGKILL" });
            queueMicrotask(() => ownedChild.emit("close", null, "SIGKILL"));
          }
          return true;
        },
      });
      queueMicrotask(() => {
        ownedChild.emit("spawn");
        signalSpawned();
      });
      return ownedChild;
    }) as unknown as typeof import("node:child_process").spawn;
    const task = runNativeExternalEditor("original", {
      env: { EDITOR: "synthetic-editor" },
      cwd: root,
      signal: controller.signal,
      tempRoot: root,
      spawn: fakeSpawn,
    });
    await spawned;
    controller.abort();
    await assert.rejects(task, /external editor did not complete successfully/);
    assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(readdirSync(root), [], "abort cleanup removes only the owned temporary file and directory");
  } finally {
    controller.abort();
    rmSync(root, { recursive: true, force: true });
  }
});
