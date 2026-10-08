import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";

import { EXECUTOR_TOOL_CATALOG_ENV, RUNTIME_ROLE_ENV, SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { loadNativeFieldKeybindings, runNativeExternalEditor } from "../src/session-host/form-support";
import { PI_AGENT_DIR_ENV } from "../src/config-path";

const FORM_TEST_SCRATCH_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-form-support-tests");
const testDirectoryIdentities = new Map<string, { dev: bigint; ino: bigint }>();

function makeFormTestDirectory(prefix: string): string {
  mkdirSync(FORM_TEST_SCRATCH_ROOT, { recursive: true });
  const root = mkdtempSync(join(FORM_TEST_SCRATCH_ROOT, `${prefix}-`));
  const stats = lstatSync(root, { bigint: true });
  testDirectoryIdentities.set(root, { dev: stats.dev, ino: stats.ino });
  return root;
}

function cleanupSuccessfulFormTestDirectory(root: string): void {
  const expected = testDirectoryIdentities.get(root);
  if (!expected) return;
  try {
    const current = lstatSync(root, { bigint: true });
    if (current.isDirectory()
      && !current.isSymbolicLink()
      && current.dev === expected.dev
      && current.ino === expected.ino) {
      rmSync(root, { recursive: true });
    }
  } catch {
    // Failed, replaced, or unknown test artifacts remain as a witness.
  }
}

function makeEditorDirectories(root: string): { agentDir: string; tempRoot: string } {
  const agentDir = join(root, "agent");
  const tempRoot = join(root, "temporary-files");
  mkdirSync(agentDir);
  mkdirSync(tempRoot);
  return { agentDir, tempRoot };
}

function editorEnv(agentDir: string, values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...values, [PI_AGENT_DIR_ENV]: agentDir };
}

function completingEditorSpawn(
  onStart: (command: string, args: string[], options: SpawnOptions) => void,
): typeof import("node:child_process").spawn {
  return ((command: string, args: string[], options: SpawnOptions) => {
    onStart(command, args, options);
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { pid: 12350, exitCode: null, signalCode: null, killed: false, kill: () => true });
    queueMicrotask(() => {
      child.emit("spawn");
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}

test("native app clear/interruption bindings reload per field without changing native TUI bindings", () => {
  const root = makeFormTestDirectory("field-keys");
  let assertionsSucceeded = false;
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const missingFile = loadNativeFieldKeybindings(agentDir);
    assert.equal(missingFile.notice, undefined, "a missing optional keybindings file is silent");
    let createdFile = false;
    try {
      lstatSync(join(agentDir, "keybindings.json"));
      createdFile = true;
    } catch {
      // The expected ENOENT proves the silent fallback did not create the user's file.
    }
    assert.equal(createdFile, false, "the silent fallback never creates the user's keybindings file");
    const defaults = loadNativeFieldKeybindings(join(root, "missing-agent"));
    assert.equal(defaults.notice, undefined, "a missing agent directory is silent too");
    assert.equal(defaults.manager.matches("\x03", "app.clear"), true, "app.clear defaults to Ctrl+C");
    assert.equal(defaults.manager.matches("\x1b", "app.interrupt"), true, "app.interrupt defaults to Escape");
    assert.equal(defaults.manager.matches("\r", "tui.input.submit"), true, "native submit keeps its real Enter default");
    const path = join(agentDir, "keybindings.json");
    const contents = `\uFEFF${JSON.stringify({
      "tui.input.submit": "f5",
      "app.clear": "ctrl+l",
      "app.interrupt": "ctrl+x",
      "app.editor.external": "alt+g",
    })}`;
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
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor uses a private bounded file, shell-free owned child, and preserves runtime role/catalog", async () => {
  const root = makeFormTestDirectory("external-editor");
  const edited = "replacement title";
  let spawnedFile = "";
  let spawnedCommand = "";
  let spawnedArgs: string[] = [];
  let spawnedOptions: SpawnOptions | undefined;
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    const fakeSpawn = ((command: string, args: string[], options: SpawnOptions) => {
      spawnedCommand = command;
      spawnedArgs = [...args];
      spawnedOptions = options;
      spawnedFile = args.at(-1) ?? "";
      assert.equal(readFileSync(spawnedFile, "utf8"), "original title");
      if (process.platform !== "win32") {
        assert.equal(lstatSync(spawnedFile).mode & 0o777, 0o600, "the private edit file is owner-only");
      } else {
        assert.equal(lstatSync(spawnedFile).isFile(), true, "the temporary file is a regular file");
      }
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
      ...editorEnv(agentDir, {
        VISUAL: "synthetic-editor --wait",
        EDITOR: "ignored-editor",
      }),
      [RUNTIME_ROLE_ENV]: "executor",
      [EXECUTOR_TOOL_CATALOG_ENV]: "private-catalog",
      [SESSION_HOST_BOOTSTRAP_ENV]: "private-token",
    };
    const result = await runNativeExternalEditor("original title", {
      env,
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    });
    assert.equal(result, edited);
    assert.equal(spawnedCommand, "synthetic-editor");
    assert.deepEqual(spawnedArgs.slice(0, -1), ["--wait"]);
    assert.ok(spawnedFile.startsWith(join(tempRoot, ".pi-review-sessions-editor-")));
    assert.equal(spawnedOptions?.shell, false);
    assert.deepEqual(spawnedOptions?.stdio, "inherit");
    assert.equal(spawnedOptions?.env?.[RUNTIME_ROLE_ENV], "executor");
    assert.equal(spawnedOptions?.env?.[EXECUTOR_TOOL_CATALOG_ENV], "private-catalog");
    assert.equal(spawnedOptions?.env?.[SESSION_HOST_BOOTSTRAP_ENV], undefined);
    assert.deepEqual(readdirSync(tempRoot), [], "the owned temporary directory is removed after completion");
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor prefers the shared global native setting and never loads a project override", async () => {
  const root = makeFormTestDirectory("external-editor-global");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    const workspace = join(root, "workspace");
    const projectAgentDir = join(workspace, ".pi");
    mkdirSync(workspace);
    mkdirSync(projectAgentDir);
    const globalSettingsPath = join(agentDir, "settings.json");
    const globalCommand = process.platform === "win32"
      ? '"global editor" --wait'
      : "'global editor' --wait";
    const originalSettings = Buffer.from(`\uFEFF${JSON.stringify({
      externalEditor: globalCommand,
      providerApiKey: "must-not-be-retained-or-echoed",
    })}`);
    const projectSettings = JSON.stringify({ externalEditor: "project-editor" });
    writeFileSync(globalSettingsPath, originalSettings);
    writeFileSync(join(projectAgentDir, "settings.json"), projectSettings, "utf8");

    let spawnedCommand = "";
    let spawnedArgs: string[] = [];
    let spawnedOptions: SpawnOptions | undefined;
    const fakeSpawn = completingEditorSpawn((command, args, options) => {
      spawnedCommand = command;
      spawnedArgs = [...args];
      spawnedOptions = options;
      assert.equal(readFileSync(args.at(-1)!, "utf8"), "initial title");
      writeFileSync(args.at(-1)!, "edited title", "utf8");
    });
    const env = editorEnv(agentDir, { VISUAL: "environment-visual", EDITOR: "environment-editor" });
    env[PI_AGENT_DIR_ENV] = "../agent";
    const result = await runNativeExternalEditor("initial title", {
      env,
      cwd: workspace,
      tempRoot,
      spawn: fakeSpawn,
    });

    assert.equal(result, "edited title");
    assert.equal(spawnedCommand, "global editor");
    assert.deepEqual(spawnedArgs.slice(0, -1), ["--wait"]);
    assert.equal(spawnedOptions?.shell, false);
    assert.equal(spawnedOptions?.env?.providerApiKey, undefined);
    assert.deepEqual(readFileSync(globalSettingsPath), originalSettings, "native settings bytes are never rewritten");
    assert.equal(readFileSync(join(projectAgentDir, "settings.json"), "utf8"), projectSettings);
    assert.deepEqual(readdirSync(tempRoot), [], "the owned editor directory is removed after actual close");
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor falls back through the captured environment and actual native default", async () => {
  const root = makeFormTestDirectory("external-editor-fallbacks");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ externalEditor: "  \t " }), "utf8");
    const defaultAgentDir = join(root, "default-agent");
    mkdirSync(defaultAgentDir);
    const commands: string[] = [];
    const fakeSpawn = completingEditorSpawn((command, args) => {
      commands.push(command);
      writeFileSync(args.at(-1)!, "done", "utf8");
    });
    const editorResult = await runNativeExternalEditor("initial", {
      env: editorEnv(agentDir, { VISUAL: "", EDITOR: "editor-fallback --line 4" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    });
    const defaultResult = await runNativeExternalEditor("initial", {
      env: editorEnv(defaultAgentDir, { VISUAL: "", EDITOR: "" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    });
    assert.equal(editorResult, "done");
    assert.equal(defaultResult, "done");
    assert.deepEqual(commands, ["editor-fallback", process.platform === "win32" ? "notepad" : "nano"]);
    assert.deepEqual(readdirSync(tempRoot), []);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor resolves the ordinary native root from the captured HOME or USERPROFILE", async () => {
  const root = makeFormTestDirectory("external-editor-home");
  let assertionsSucceeded = false;
  try {
    const tempRoot = join(root, "temporary-files");
    const homeRoot = join(root, "captured-home");
    const agentDir = join(homeRoot, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(tempRoot);
    const settingsPath = join(agentDir, "settings.json");
    const settingsBytes = Buffer.from(JSON.stringify({ externalEditor: "home-editor" }));
    writeFileSync(settingsPath, settingsBytes);
    const env: NodeJS.ProcessEnv = process.platform === "win32"
      ? { USERPROFILE: homeRoot }
      : { HOME: homeRoot };
    let command = "";
    const fakeSpawn = completingEditorSpawn((spawnCommand, args) => {
      command = spawnCommand;
      writeFileSync(args.at(-1)!, "done", "utf8");
    });
    assert.equal(await runNativeExternalEditor("initial", { env, cwd: root, tempRoot, spawn: fakeSpawn }), "done");
    assert.equal(command, "home-editor");
    assert.deepEqual(readFileSync(settingsPath), settingsBytes);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("Windows editor argv parsing preserves quoted executable backslashes and escaped quotes", async () => {
  const root = makeFormTestDirectory("external-editor-windows-argv");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    const env = editorEnv(agentDir, {
      VISUAL: '"C:\\Program Files\\Editor\\editor.exe" --wait "say \\"hi\\""',
    });
    let command = "";
    let args: string[] = [];
    let shell: SpawnOptions["shell"];
    const fakeSpawn = completingEditorSpawn((spawnCommand, spawnArgs, options) => {
      command = spawnCommand;
      args = [...spawnArgs];
      shell = options.shell;
      writeFileSync(spawnArgs.at(-1)!, "done", "utf8");
    });
    assert.equal(await runNativeExternalEditor("initial", {
      env,
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
      platform: "win32",
    }), "done");
    assert.equal(command, "C:\\Program Files\\Editor\\editor.exe");
    assert.deepEqual(args.slice(0, -1), ["--wait", 'say "hi"']);
    assert.equal(shell, false);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("Windows command and batch editor shims fail before spawn", async () => {
  const root = makeFormTestDirectory("external-editor-windows-shim");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    let spawnCalled = false;
    const fakeSpawn = completingEditorSpawn(() => { spawnCalled = true; });
    await assert.rejects(runNativeExternalEditor("initial", {
      env: editorEnv(agentDir, { VISUAL: "C:\\Editors\\editor.cmd --wait" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
      platform: "win32",
    }), /command-shell editor shims are unsupported/);
    assert.equal(spawnCalled, false);
    assert.deepEqual(readdirSync(tempRoot), [], "unsupported config does not create a temporary handoff");
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("POSIX editor lexer preserves non-special double-quote backslashes without shell expansion", { skip: process.platform === "win32" }, async () => {
  const root = makeFormTestDirectory("external-editor-posix-argv");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    const env = editorEnv(agentDir, {
      VISUAL: 'synthetic-editor --value "path\\q and \\"quoted\\" $HOME"',
    });
    let args: string[] = [];
    const fakeSpawn = completingEditorSpawn((_command, spawnArgs) => {
      args = [...spawnArgs];
      writeFileSync(spawnArgs.at(-1)!, "done", "utf8");
    });
    assert.equal(await runNativeExternalEditor("initial", { env, cwd: root, tempRoot, spawn: fakeSpawn }), "done");
    assert.deepEqual(args.slice(0, -1), ["--value", 'path\\q and "quoted" $HOME']);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("malformed native settings fail closed without echoing content or spawning", async () => {
  const root = makeFormTestDirectory("external-editor-malformed-settings");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    const settingsPath = join(agentDir, "settings.json");
    const secret = "must-not-appear-in-error";
    const settingsBytes = Buffer.from(`{\"externalEditor\":\"${secret}\", invalid`);
    writeFileSync(settingsPath, settingsBytes);
    let spawnCalled = false;
    const fakeSpawn = completingEditorSpawn(() => { spawnCalled = true; });
    await assert.rejects(runNativeExternalEditor("initial", {
      env: editorEnv(agentDir, { EDITOR: "safe-fallback" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    }), (error: unknown) => {
      assert.match(String(error), /settings\.json is malformed or unsupported/);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
    assert.equal(spawnCalled, false);
    assert.deepEqual(readFileSync(settingsPath), settingsBytes);
    assert.deepEqual(readdirSync(tempRoot), []);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("non-string native externalEditor values do not fall back to environment commands", async () => {
  const root = makeFormTestDirectory("external-editor-non-string-setting");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    const settingsPath = join(agentDir, "settings.json");
    const settingsBytes = Buffer.from(JSON.stringify({ externalEditor: { command: "not-a-scalar" } }));
    writeFileSync(settingsPath, settingsBytes);
    let spawnCalled = false;
    const fakeSpawn = completingEditorSpawn(() => { spawnCalled = true; });
    await assert.rejects(runNativeExternalEditor("initial", {
      env: editorEnv(agentDir, { EDITOR: "environment-fallback" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    }), /unsupported externalEditor value/);
    assert.equal(spawnCalled, false);
    assert.deepEqual(readFileSync(settingsPath), settingsBytes);
    assert.deepEqual(readdirSync(tempRoot), []);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("unsafe or oversized native settings fail closed before editor handoff", async (t) => {
  if (process.platform !== "win32") {
    await t.test("a settings symlink is not followed", async () => {
      const root = makeFormTestDirectory("external-editor-settings-symlink");
      let assertionsSucceeded = false;
      try {
        const { agentDir, tempRoot } = makeEditorDirectories(root);
        const targetPath = join(agentDir, "settings-target.json");
        const settingsPath = join(agentDir, "settings.json");
        const targetBytes = Buffer.from(JSON.stringify({ externalEditor: "target-editor" }));
        writeFileSync(targetPath, targetBytes);
        symlinkSync(targetPath, settingsPath);
        let spawnCalled = false;
        const fakeSpawn = completingEditorSpawn(() => { spawnCalled = true; });
        await assert.rejects(runNativeExternalEditor("initial", {
          env: editorEnv(agentDir, { EDITOR: "fallback-editor" }),
          cwd: root,
          tempRoot,
          spawn: fakeSpawn,
        }), /settings\.json is unavailable or unsafe/);
        assert.equal(spawnCalled, false);
        assert.equal(lstatSync(settingsPath).isSymbolicLink(), true);
        assert.deepEqual(readFileSync(targetPath), targetBytes);
        assert.deepEqual(readdirSync(tempRoot), []);
        assertionsSucceeded = true;
      } finally {
        if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
      }
    });
  }

  await t.test("oversized settings are not read or handed to an editor", async () => {
    const root = makeFormTestDirectory("external-editor-settings-oversized");
    let assertionsSucceeded = false;
    try {
      const { agentDir, tempRoot } = makeEditorDirectories(root);
      const settingsPath = join(agentDir, "settings.json");
      const settingsBytes = Buffer.alloc(256 * 1024 + 1, 0x20);
      writeFileSync(settingsPath, settingsBytes);
      let spawnCalled = false;
      const fakeSpawn = completingEditorSpawn(() => { spawnCalled = true; });
      await assert.rejects(runNativeExternalEditor("initial", {
        env: editorEnv(agentDir, { EDITOR: "fallback-editor" }),
        cwd: root,
        tempRoot,
        spawn: fakeSpawn,
      }), /settings\.json is unavailable or unsafe/);
      assert.equal(spawnCalled, false);
      assert.deepEqual(readFileSync(settingsPath), settingsBytes);
      assert.deepEqual(readdirSync(tempRoot), []);
      assertionsSucceeded = true;
    } finally {
      if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
    }
  });
});

test("malformed native keybindings keep their fail-safe notice and default bindings", () => {
  const root = makeFormTestDirectory("field-keybindings-malformed");
  let assertionsSucceeded = false;
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const path = join(agentDir, "keybindings.json");
    writeFileSync(path, "{invalid json", "utf8");
    const result = loadNativeFieldKeybindings(agentDir);
    assert.match(result.notice ?? "", /unsupported format/);
    assert.equal(result.manager.matches("\x03", "app.clear"), true, "the fail-safe manager keeps the real defaults");
    assert.equal(readFileSync(path, "utf8"), "{invalid json");
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("native field keybindings do not follow a symlinked settings file", { skip: process.platform === "win32" }, () => {
  const root = makeFormTestDirectory("field-keybindings-symlink");
  let assertionsSucceeded = false;
  try {
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const targetPath = join(root, "target.json");
    const targetContents = JSON.stringify({ "app.clear": "ctrl+l" });
    writeFileSync(targetPath, targetContents);
    symlinkSync(targetPath, join(agentDir, "keybindings.json"));
    const result = loadNativeFieldKeybindings(agentDir);
    assert.match(result.notice ?? "", /unavailable/);
    assert.equal(result.manager.matches("\x03", "app.clear"), true);
    assert.equal(readFileSync(targetPath, "utf8"), targetContents);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("successful editor atomic-save replacement is read only after owned child close", async () => {
  const root = makeFormTestDirectory("external-editor-atomic-save");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    let editorDirectory = "";
    let backupPath = "";
    const fakeSpawn = completingEditorSpawn((_command, args) => {
      const filePath = args.at(-1)!;
      editorDirectory = join(filePath, "..");
      const normalizedDirectory = join(editorDirectory);
      const replacementPath = join(normalizedDirectory, "replacement.txt");
      backupPath = join(normalizedDirectory, "editor-backup.txt");
      writeFileSync(replacementPath, "atomically saved", "utf8");
      renameSync(filePath, backupPath);
      renameSync(replacementPath, filePath);
    });
    assert.equal(await runNativeExternalEditor("initial", {
      env: editorEnv(agentDir, { EDITOR: "synthetic-editor" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    }), "atomically saved");
    assert.equal(readFileSync(backupPath, "utf8"), "initial", "unknown editor backup content is preserved");
    assert.deepEqual(readdirSync(tempRoot), [editorDirectory.split(/[\\/]/).at(-1)]);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("spawn errors are not applied and unknown editor-created siblings survive cleanup", async () => {
  const root = makeFormTestDirectory("external-editor-spawn-error");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
    let unknownPath = "";
    const fakeSpawn = ((_command: string, args: string[]) => {
      const filePath = args.at(-1)!;
      const directory = join(filePath, "..");
      unknownPath = join(directory, "editor-created-unknown.txt");
      writeFileSync(filePath, "failed editor result", "utf8");
      writeFileSync(unknownPath, "preserve unknown editor resource", "utf8");
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 12351, exitCode: null, signalCode: null, killed: false, kill: () => true });
      queueMicrotask(() => {
        child.emit("error", new Error("synthetic spawn failure"));
        child.emit("close", -1, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    await assert.rejects(runNativeExternalEditor("initial", {
      env: editorEnv(agentDir, { EDITOR: "synthetic-editor" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    }), /external editor could not be started/);
    assert.equal(readFileSync(unknownPath, "utf8"), "preserve unknown editor resource");
    assert.deepEqual(readdirSync(tempRoot), [unknownPath.split(/[\\/]/).at(-2)]);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor removes one final line terminator but preserves meaningful spaces and multiline data", async () => {
  const root = makeFormTestDirectory("external-editor-lines");
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
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
        env: editorEnv(agentDir, { EDITOR: "synthetic-editor" }),
        cwd: root,
        tempRoot,
        spawn: fakeSpawn,
      });
    };

    assert.equal(await runWithResult("  title with spaces  \r\n"), "  title with spaces  ");
    assert.equal(await runWithResult("first\nsecond\n"), "first\nsecond", "only one conventional terminal newline is removed");
    assert.deepEqual(readdirSync(tempRoot), []);
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor cleanup preserves a replaced symlink and its target", { skip: process.platform === "win32" }, async () => {
  const root = makeFormTestDirectory("external-editor-replaced");
  const target = join(root, "user-file.txt");
  let replacedPath = "";
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
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
      env: editorEnv(agentDir, { EDITOR: "synthetic-editor" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    }), /temporary file was replaced/);
    assert.equal(readFileSync(target, "utf8"), "preserve this file");
    assert.equal(lstatSync(replacedPath).isSymbolicLink(), true, "cleanup does not unlink a substituted path by name");
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("external editor rejects a replaced temporary directory without touching its symlink target", { skip: process.platform === "win32" }, async () => {
  const root = makeFormTestDirectory("external-editor-directory-replaced");
  const target = join(root, "unrelated-directory");
  const movedDirectory = join(root, "moved-owned-directory");
  let replacedDirectory = "";
  let assertionsSucceeded = false;
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
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
      env: editorEnv(agentDir, { EDITOR: "synthetic-editor" }),
      cwd: root,
      tempRoot,
      spawn: fakeSpawn,
    }), /temporary directory was replaced/);
    assert.equal(readFileSync(join(target, "field.txt"), "utf8"), "preserve this unrelated field");
    assert.equal(lstatSync(replacedDirectory).isSymbolicLink(), true, "the replaced directory entry is not removed by name");
    assert.deepEqual(readdirSync(movedDirectory), ["field.txt"], "uncertain cleanup leaves the moved original entry rather than following the replacement");
    assert.equal(readFileSync(join(movedDirectory, "field.txt"), "utf8"), "original");
    assertionsSucceeded = true;
  } finally {
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});

test("aborting the external-editor handoff escalates only its owned child", async () => {
  const root = makeFormTestDirectory("external-editor-abort");
  const controller = new AbortController();
  const calls: string[] = [];
  let child: ChildProcess | undefined;
  let assertionsSucceeded = false;
  let signalSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => { signalSpawned = resolve; });
  try {
    const { agentDir, tempRoot } = makeEditorDirectories(root);
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
      env: editorEnv(agentDir, { EDITOR: "synthetic-editor" }),
      cwd: root,
      signal: controller.signal,
      tempRoot,
      spawn: fakeSpawn,
    });
    await spawned;
    controller.abort();
    await assert.rejects(task, /external editor did not complete successfully/);
    assert.deepEqual(calls, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(readdirSync(tempRoot), [], "abort cleanup removes only the owned temporary file and directory");
    assertionsSucceeded = true;
  } finally {
    controller.abort();
    if (assertionsSucceeded) cleanupSuccessfulFormTestDirectory(root);
  }
});
