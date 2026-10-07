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
  type BigIntStats,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type KeybindingsConfig,
  type KeybindingsManager as KeybindingsManagerType,
} from "pi-session-host-tui";

import { SESSION_HOST_BOOTSTRAP_ENV } from "./launch";
import type { SessionHostFieldKeybindings } from "./field-editor";
import { PI_AGENT_DIR_ENV, normalizeWindowsShellPath } from "../config-path";
import { defaultProfileStateRoot, nativePiAgentDir } from "./profiles";

/** Public app-level actions consumed by the field; the Editor bindings remain the public TUI definitions. */
const FORM_KEYBINDING_DEFINITIONS = {
  ...TUI_KEYBINDINGS,
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear the session-host field" },
  "app.interrupt": { defaultKeys: "escape", description: "Cancel the session-host field" },
  "app.editor.external": { defaultKeys: "ctrl+g", description: "Edit the session-host field externally" },
} as const;

const MAX_KEYBINDINGS_BYTES = 256 * 1024;
const MAX_NATIVE_SETTINGS_BYTES = 256 * 1024;
const MAX_EDITOR_TEXT_BYTES = 8192;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

type FileIdentity = { readonly dev: bigint; readonly ino: bigint };

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
  let bytes: Buffer | undefined;
  try {
    bytes = readBoundedRegularFile(path, MAX_KEYBINDINGS_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      manager: new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS),
      notice: code === "ENOENT"
        ? "Native keybindings.json is absent; using Pi's default form keys"
        : "Native keybindings.json is unavailable; using Pi's default form keys",
    };
  }
  if (bytes === undefined) {
    return {
      manager: new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS),
      notice: "Native keybindings.json is absent; using Pi's default form keys",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeNativeJson(bytes));
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
 * Execute the effective native global external-editor command without a
 * shell, against a private bounded temporary file. Only the editor process
 * owned by this call receives the file path; cleanup removes entries only
 * while their observed device/inode identity still matches this call's temp
 * directory.
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
    /** @internal Parser/default test seam only; production always uses the actual platform. */
    readonly platform?: NodeJS.Platform;
  },
): Promise<string> {
  const input = Buffer.from(text, "utf8");
  if (input.byteLength > MAX_EDITOR_TEXT_BYTES || text.includes("\0")) {
    throw new Error("external editor input is outside the bounded field limit");
  }
  const platform = options.platform ?? process.platform;
  const editorText = resolveExternalEditorCommand(options.env, options.cwd, platform);
  const command = splitEditorCommand(editorText, platform);
  if (command.length === 0 || command[0]!.length === 0) throw new Error("external editor command is empty");
  assertSupportedEditorCommand(command, platform);

  const root = options.tempRoot ?? tmpdir();
  const directory = mkdtempSync(join(root, ".pi-review-sessions-editor-"));
  const directoryStats = lstatSync(directory, { bigint: true });
  const directoryIdentity = identity(directoryStats);
  let filePath: string | undefined;
  let cleanupIdentity: FileIdentity | undefined;
  let descriptor: number | undefined;
  try {
    if (!directoryStats.isDirectory()
      || directoryStats.isSymbolicLink()
      || (process.platform !== "win32" && (directoryStats.mode & 0o077n) !== 0n)) {
      throw new Error("external editor temporary directory is not a fresh usable directory");
    }
    assertOwnedDirectory(directory, directoryIdentity);
    filePath = join(directory, "field.txt");
    descriptor = openSync(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW, 0o600);
    const createdStats = fstatSync(descriptor, { bigint: true });
    const createdPathStats = lstatSync(filePath, { bigint: true });
    if (!createdStats.isFile()
      || createdPathStats.isSymbolicLink()
      || !createdPathStats.isFile()
      || !sameIdentity(identity(createdStats), identity(createdPathStats))) {
      throw new Error("external editor temporary file is unavailable");
    }
    cleanupIdentity = identity(createdStats);
    writeFileSync(descriptor, input);
    closeSync(descriptor);
    descriptor = undefined;
    assertOwnedRegularFile(filePath, cleanupIdentity);

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
    const pathStats = lstatSync(filePath, { bigint: true });
    if (!pathStats.isFile() || pathStats.isSymbolicLink()) throw new Error("external editor temporary file was replaced");
    const pathIdentity = identity(pathStats);
    const readDescriptor = openSync(filePath, fsConstants.O_RDONLY | NONBLOCK | NOFOLLOW);
    let readDescriptorClosed = false;
    try {
      const openedStats = fstatSync(readDescriptor, { bigint: true });
      const confirmedPathStats = lstatSync(filePath, { bigint: true });
      if (!openedStats.isFile()
        || !confirmedPathStats.isFile()
        || confirmedPathStats.isSymbolicLink()
        || !sameIdentity(pathIdentity, identity(openedStats))
        || !sameIdentity(pathIdentity, identity(confirmedPathStats))
        || openedStats.size > BigInt(MAX_EDITOR_TEXT_BYTES)) {
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
      assertOwnedRegularFile(filePath, pathIdentity);
      closeSync(readDescriptor);
      readDescriptorClosed = true;
      cleanupIdentity = pathIdentity;
      return removeFinalLineTerminator(decoded);
    } finally {
      if (!readDescriptorClosed) {
        try { closeSync(readDescriptor); } catch { /* descriptor is already closed or validation failed */ }
      }
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

function resolveExternalEditorCommand(env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform): string {
  const configured = readNativeExternalEditorSetting(env, cwd);
  if (configured !== undefined && configured.trim().length > 0) return configured;
  return env.VISUAL || env.EDITOR || (platform === "win32" ? "notepad" : "nano");
}

/** Read only the native global externalEditor scalar; project settings are deliberately not consulted. */
function readNativeExternalEditorSetting(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const nativeEnv = { ...env };
  const override = nativeEnv[PI_AGENT_DIR_ENV];
  if (override) {
    const normalized = process.platform === "win32" ? normalizeWindowsShellPath(override) : override;
    const isTildePath = normalized === "~"
      || normalized.startsWith("~/")
      || (process.platform === "win32" && normalized.startsWith("~\\"));
    if (!isTildePath && !isAbsolute(normalized)) {
      nativeEnv[PI_AGENT_DIR_ENV] = resolve(cwd, normalized);
    } else {
      nativeEnv[PI_AGENT_DIR_ENV] = normalized;
    }
  }

  // Match the existing native-root resolver. A genuinely absent root has no
  // settings file and therefore uses Pi's ordinary environment/default path.
  let expectedAgentDir: string;
  try {
    expectedAgentDir = dirname(defaultProfileStateRoot(nativeEnv));
  } catch {
    throw new Error("native Pi settings location is unavailable; external editor was not started");
  }
  try {
    lstatSync(expectedAgentDir, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("native Pi settings location is unavailable; external editor was not started");
  }

  let agentDir: string;
  try {
    agentDir = nativePiAgentDir(nativeEnv);
  } catch {
    throw new Error("native Pi settings location is unavailable; external editor was not started");
  }
  let bytes: Buffer | undefined;
  try {
    bytes = readBoundedRegularFile(join(agentDir, "settings.json"), MAX_NATIVE_SETTINGS_BYTES);
  } catch {
    throw new Error("native Pi settings.json is unavailable or unsafe; external editor was not started");
  }
  if (bytes === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeNativeJson(bytes));
  } catch {
    throw new Error("native Pi settings.json is malformed or unsupported; external editor was not started");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("native Pi settings.json is malformed or unsupported; external editor was not started");
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "externalEditor")) return undefined;
  const editor = (parsed as Record<string, unknown>).externalEditor;
  if (typeof editor !== "string") {
    throw new Error("native Pi settings.json has an unsupported externalEditor value; editor was not started");
  }
  return editor;
}

/** Small platform-aware argv lexer; it never expands or evaluates shell syntax. */
function splitEditorCommand(value: string, platform: NodeJS.Platform): string[] {
  if (typeof value !== "string" || value.length > 4096 || /[\0\r\n]/.test(value)) {
    throw new Error("external editor command is invalid");
  }
  if (platform === "win32") return splitWindowsEditorCommand(value);

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
      else if (char === "\\" && index + 1 < value.length && '"\\$`'.includes(value[index + 1]!)) {
        word += value[++index]!;
      } else word += char;
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

function splitWindowsEditorCommand(value: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quoted = false;
  for (let index = 0; index < value.length;) {
    if (value[index] === "\\") {
      let end = index;
      while (value[end] === "\\") end += 1;
      const slashCount = end - index;
      if (value[end] === '"') {
        word += "\\".repeat(Math.floor(slashCount / 2));
        started = true;
        if (slashCount % 2 === 1) {
          word += '"';
        } else if (quoted && value[end + 1] === '"') {
          word += '"';
          end += 1;
        } else {
          quoted = !quoted;
        }
        index = end + 1;
      } else {
        word += "\\".repeat(slashCount);
        started = true;
        index = end;
      }
      continue;
    }
    const char = value[index]!;
    if (char === '"') {
      started = true;
      if (quoted && value[index + 1] === '"') {
        word += '"';
        index += 2;
      } else {
        quoted = !quoted;
        index += 1;
      }
    } else if (/\s/.test(char) && !quoted) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      index += 1;
    } else {
      word += char;
      started = true;
      index += 1;
    }
  }
  if (quoted) throw new Error("external editor command has an unmatched quote");
  if (started) words.push(word);
  return words;
}

function assertSupportedEditorCommand(command: string[], platform: NodeJS.Platform): void {
  if (platform !== "win32" || command.length === 0) return;
  const executable = command[0]!.split(/[\\/]/).at(-1)!.toLowerCase();
  if (executable === "cmd" || executable === "cmd.exe" || /\.(?:cmd|bat)$/.test(executable)) {
    throw new Error("Windows command-shell editor shims are unsupported; external editor was not started");
  }
}

function identity(stats: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertOwnedDirectory(path: string, expected: FileIdentity): void {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory() || stats.isSymbolicLink() || !sameIdentity(identity(stats), expected)) {
    throw new Error("external editor temporary directory was replaced");
  }
}

function assertOwnedRegularFile(path: string, expected: FileIdentity): void {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(identity(stats), expected)) {
    throw new Error("external editor temporary file was replaced");
  }
}

function unlinkOwnedFile(path: string, expected: FileIdentity, directory: string, directoryIdentity: FileIdentity): void {
  try {
    assertOwnedDirectory(directory, directoryIdentity);
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || !sameIdentity(identity(stats), expected)) return;
    assertOwnedDirectory(directory, directoryIdentity);
    const confirmed = lstatSync(path, { bigint: true });
    if (!confirmed.isFile() || confirmed.isSymbolicLink() || !sameIdentity(identity(confirmed), expected)) return;
    assertOwnedDirectory(directory, directoryIdentity);
    unlinkSync(path);
  } catch {
    // Missing, replaced, or inaccessible entries are never deleted by name alone.
  }
}

function removeOwnedDirectory(path: string, expected: FileIdentity): void {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isDirectory() && !stats.isSymbolicLink() && sameIdentity(identity(stats), expected)) rmdirSync(path);
  } catch {
    // A replacement or nonempty directory remains untouched.
  }
}

/** Bounded preflight/open/descriptor/path identity check for native JSON files. */
function readBoundedRegularFile(path: string, maxBytes: number): Buffer | undefined {
  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("native configuration file is unavailable");
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("native configuration file is not a regular non-symlink file");
  }
  if (before.size > BigInt(maxBytes)) throw new Error("native configuration file exceeds its bounded read limit");

  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | NONBLOCK | NOFOLLOW);
  } catch {
    throw new Error("native configuration file is unavailable");
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const confirmedPath = lstatSync(path, { bigint: true });
    if (!opened.isFile()
      || confirmedPath.isSymbolicLink()
      || !confirmedPath.isFile()
      || !sameIdentity(identity(before), identity(opened))
      || !sameIdentity(identity(before), identity(confirmedPath))
      || opened.size > BigInt(maxBytes)) {
      throw new Error("native configuration file changed or is not a bounded regular file");
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    if (offset > maxBytes) throw new Error("native configuration file exceeds its bounded read limit");
    const afterRead = lstatSync(path, { bigint: true });
    const descriptorAfterRead = fstatSync(descriptor, { bigint: true });
    if (afterRead.isSymbolicLink()
      || !afterRead.isFile()
      || !sameIdentity(identity(before), identity(afterRead))
      || !sameIdentity(identity(before), identity(descriptorAfterRead))) {
      throw new Error("native configuration file changed during its bounded read");
    }
    return Buffer.from(bytes.subarray(0, offset));
  } finally {
    try { closeSync(descriptor); } catch { /* completed bounded reads only */ }
  }
}

function decodeNativeJson(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text.startsWith("\uFEFF") ? text.slice(1) : text;
}

/** Public constructor reference retained as a narrow integration test seam. */
export function createNativeFieldKeybindingsManager(config?: KeybindingsConfig): KeybindingsManagerType {
  return new KeybindingsManager(FORM_KEYBINDING_DEFINITIONS, config);
}

/** Resolve a host-startup-relative native path for explicit field suggestions. */
export function resolveWorkspaceBasePath(cwd: string): string {
  return isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd);
}
