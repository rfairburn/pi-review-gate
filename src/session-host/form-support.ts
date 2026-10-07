import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type KeybindingsConfig,
  type KeybindingsManager as KeybindingsManagerType,
} from "pi-session-host-tui";

import { SESSION_HOST_BOOTSTRAP_ENV } from "./launch";
import type { SessionHostFieldKeybindings } from "./field-editor";

/** Public app-level actions consumed by the field; the Editor bindings remain the public TUI definitions. */
const FORM_KEYBINDING_DEFINITIONS = {
  ...TUI_KEYBINDINGS,
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear the session-host field" },
  "app.interrupt": { defaultKeys: "escape", description: "Cancel the session-host field" },
  "app.editor.external": { defaultKeys: "ctrl+g", description: "Edit the session-host field externally" },
} as const;

const MAX_KEYBINDINGS_BYTES = 256 * 1024;
const MAX_EDITOR_TEXT_BYTES = 8192;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

type FileIdentity = { readonly dev: number; readonly ino: number };

export interface NativeFieldKeybindings {
  readonly manager: SessionHostFieldKeybindings;
  /** Non-secret, bounded notice for absent, unreadable, or unsupported native configuration. */
  readonly notice?: string;
}

/**
 * Read the normal native keybindings file without following a blocking special
 * file, reading secrets, or modifying/copying the user's configuration. A new
 * manager is built for every form open so edits made between forms take effect.
 */
export function loadNativeFieldKeybindings(agentDir: string): NativeFieldKeybindings {
  const path = join(agentDir, "keybindings.json");
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | NONBLOCK | NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        manager: new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS),
        notice: "Native keybindings.json is absent; using Pi's default form keys",
      };
    }
    return {
      manager: new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS),
      notice: "Native keybindings.json is unavailable; using Pi's default form keys",
    };
  }

  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_KEYBINDINGS_BYTES) {
      return unsupportedKeybindings();
    }
    const bytes = Buffer.allocUnsafe(MAX_KEYBINDINGS_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    if (offset > MAX_KEYBINDINGS_BYTES) return unsupportedKeybindings();

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)));
    } catch {
      return unsupportedKeybindings();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return unsupportedKeybindings();
    }

    const bindings: Record<string, string | string[]> = {};
    for (const [action, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        if (!isSafeBinding(value)) return unsupportedKeybindings();
        bindings[action] = value;
      } else if (Array.isArray(value)
        && value.length <= 32
        && value.every((key) => typeof key === "string" && isSafeBinding(key))) {
        bindings[action] = [...value];
      } else {
        return unsupportedKeybindings();
      }
    }
    try {
      return { manager: new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS, bindings as KeybindingsConfig) };
    } catch {
      return unsupportedKeybindings();
    }
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // The read has already completed; descriptor cleanup is best-effort.
    }
  }
}

function isSafeBinding(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function unsupportedKeybindings(): NativeFieldKeybindings {
  return {
    manager: new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS),
    notice: "Native keybindings.json has an unsupported format; using Pi's default form keys",
  };
}

/**
 * Execute the user's trusted VISUAL/EDITOR command without a shell, against a
 * private bounded temporary file. Only the editor process owned by this call
 * receives the file path; cleanup removes entries only while their observed
 * device/inode identity still matches this call's private temp directory.
 */
export async function runNativeExternalEditor(
  text: string,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly signal?: AbortSignal;
    /** Root-only test seam; production uses the OS temporary directory. */
    readonly tempRoot?: string;
    readonly spawn?: typeof nodeSpawn;
  },
): Promise<string> {
  const input = Buffer.from(text, "utf8");
  if (input.byteLength > MAX_EDITOR_TEXT_BYTES || text.includes("\0")) {
    throw new Error("external editor input is outside the bounded field limit");
  }
  const editorText = options.env.VISUAL || options.env.EDITOR || "vi";
  const command = splitEditorCommand(editorText);
  if (command.length === 0) throw new Error("external editor command is empty");

  const root = options.tempRoot ?? tmpdir();
  const directory = mkdtempSync(join(root, ".pi-review-sessions-editor-"));
  const directoryStats = lstatSync(directory);
  if (!directoryStats.isDirectory() || (directoryStats.mode & 0o077) !== 0) {
    throw new Error("external editor temporary directory is not private");
  }
  const directoryIdentity = identity(directoryStats);
  let filePath: string | undefined;
  let cleanupIdentity: FileIdentity | undefined;
  let descriptor: number | undefined;
  try {
    assertOwnedDirectory(directory, directoryIdentity);
    filePath = join(directory, "field.txt");
    descriptor = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    const createdStats = fstatSync(descriptor);
    if (!createdStats.isFile()) throw new Error("external editor temporary file is unavailable");
    cleanupIdentity = identity(createdStats);
    writeFileSync(descriptor, input);
    closeSync(descriptor);
    descriptor = undefined;

    const childEnv = externalEditorEnvironment(options.env);
    const spawn = options.spawn ?? nodeSpawn;
    if (options.signal?.aborted) throw new Error("external editor was interrupted");
    assertOwnedDirectory(directory, directoryIdentity);
    const child = spawn(command[0]!, [...command.slice(1), filePath], {
      cwd: options.cwd,
      env: childEnv,
      stdio: "inherit",
      shell: false,
    });
    await waitForEditor(child, options.signal);
    if (options.signal?.aborted) throw new Error("external editor was interrupted");

    assertOwnedDirectory(directory, directoryIdentity);
    const pathStats = lstatSync(filePath);
    if (!pathStats.isFile()) throw new Error("external editor temporary file was replaced");
    const pathIdentity = identity(pathStats);
    const readDescriptor = openSync(filePath, fsConstants.O_RDONLY | NONBLOCK | NOFOLLOW);
    try {
      const openedStats = fstatSync(readDescriptor);
      if (!openedStats.isFile() || !sameIdentity(pathIdentity, identity(openedStats)) || openedStats.size > MAX_EDITOR_TEXT_BYTES) {
        throw new Error("external editor result is not a bounded regular file");
      }
      const bytes = Buffer.allocUnsafe(MAX_EDITOR_TEXT_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(readDescriptor, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) break;
        offset += count;
      }
      if (offset > MAX_EDITOR_TEXT_BYTES) throw new Error("external editor result exceeds the field limit");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      assertOwnedDirectory(directory, directoryIdentity);
      cleanupIdentity = pathIdentity;
      return removeFinalLineTerminator(decoded);
    } finally {
      closeSync(readDescriptor);
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* owned descriptor cleanup only */ }
    }
    if (filePath && cleanupIdentity) unlinkOwnedFile(filePath, cleanupIdentity, directory, directoryIdentity);
    removeOwnedDirectory(directory, directoryIdentity);
  }
}

function waitForEditor(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let spawnFailed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const killOwnedEditor = (): void => {
      try { child.kill("SIGTERM"); } catch { /* exact owned child only */ }
      if (killTimer === undefined) {
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch { /* exact owned child only */ }
          }
        }, 1000);
      }
    };
    const onAbort = (): void => killOwnedEditor();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) killOwnedEditor();
    child.once("spawn", () => { if (signal?.aborted) killOwnedEditor(); });
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code, childSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!spawnFailed && code === 0 && childSignal === null && !signal?.aborted) resolvePromise();
      else rejectPromise(new Error(spawnFailed
        ? "external editor could not be started"
        : "external editor did not complete successfully"));
    });
  });
}

function externalEditorEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...source };
  delete result[SESSION_HOST_BOOTSTRAP_ENV];
  return result;
}

function removeFinalLineTerminator(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}

/** Small shell-word lexer: quotes/backslashes are syntax; no shell expansion or evaluation occurs. */
function splitEditorCommand(value: string): string[] {
  if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error("external editor command is invalid");
  }
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote === "single") {
      if (char === "'") quote = undefined;
      else word += char;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') quote = undefined;
      else if (char === "\\" && index + 1 < value.length) word += value[++index]!;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double";
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else if (char === "\\" && index + 1 < value.length) {
      word += value[++index]!;
      started = true;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== undefined) throw new Error("external editor command has an unmatched quote");
  if (started) words.push(word);
  return words;
}

function identity(stats: { dev: number; ino: number }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedDirectory(path: string, expected: FileIdentity): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || !sameIdentity(identity(stats), expected)) {
    throw new Error("external editor temporary directory was replaced");
  }
}

function unlinkOwnedFile(path: string, expected: FileIdentity, directory: string, directoryIdentity: FileIdentity): void {
  try {
    assertOwnedDirectory(directory, directoryIdentity);
    const stats = lstatSync(path);
    if (!stats.isFile() || !sameIdentity(identity(stats), expected)) return;
    assertOwnedDirectory(directory, directoryIdentity);
    const confirmed = lstatSync(path);
    if (!confirmed.isFile() || !sameIdentity(identity(confirmed), expected)) return;
    assertOwnedDirectory(directory, directoryIdentity);
    unlinkSync(path);
  } catch {
    // Missing, replaced, or inaccessible entries are never deleted by name alone.
  }
}

function removeOwnedDirectory(path: string, expected: FileIdentity): void {
  try {
    const stats = lstatSync(path);
    if (stats.isDirectory() && sameIdentity(identity(stats), expected)) rmdirSync(path);
  } catch {
    // A replacement or nonempty directory remains untouched.
  }
}

/** Public constructor reference retained as a narrow integration test seam. */
export function createNativeFieldKeybindingsManager(config?: KeybindingsConfig): KeybindingsManagerType {
  return new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS, config);
}

/** Resolve a host-startup-relative native path for explicit field suggestions. */
export function resolveWorkspaceBasePath(cwd: string): string {
  return isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
}
