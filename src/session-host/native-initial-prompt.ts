/**
 * Owned file-backed initial prompt for native TUI startup fallback (issue #493).
 *
 * When a native provider (Claude Code, Codex) offers no same-session API/RPC
 * route for the initial request, the launcher may instead pass one short
 * generated instruction as a single argv operand after `--`. The instruction
 * asks the native session to read one private file and carry out its decoded
 * content as the user's initial request. This is explicitly a file-backed
 * wrapper: the original prompt does not appear verbatim as the first native user
 * message, and it never travels through argv or the environment.
 *
 * Safety contract (fail closed):
 *
 * - The original prompt is admitted with the existing policy (nonempty string
 *   without NUL) and staged exactly, with no size cap or shortening, as one
 *   canonical pretty-printed JSON array of bounded string fragments, one
 *   fragment per line (see {@link encodeNativeInitialPromptFile}). The
 *   fragment bound is line framing only, never a prompt limit: a native file
 *   reader that caps or pages long files can read every line, and the exact
 *   prompt is the in-order concatenation of the decoded fragments with no
 *   separators. A valid surrogate pair is never split across fragments, and
 *   JSON escapes preserve CR/LF, controls, and lone surrogates exactly.
 * - Each lease owns one fresh private `0700` `mkdtemp` root under the OS
 *   temporary directory (outside any workspace) holding one exclusive `0600`
 *   file written by {@link stageSessionHostPayload}, which pins identity,
 *   size, and digest and discards only the exact unchanged inode.
 * - The generated path is embedded as a JSON string literal. A temporary root
 *   whose path contains control, format, separator, non-space whitespace,
 *   unpaired surrogate, or `@` code points is refused before the prompt is
 *   written: the instruction stays one printable plain-word line that cannot
 *   gain argv, slash-command, file-reference, or instruction structure. Its
 *   length follows only from the OS path and argv bounds; no separate cap is
 *   imposed. No `@` reference syntax, trust, permission,
 *   filesystem-exposure, model, or reasoning setting is implied; the native
 *   session reads the file through its normal file-read and approval behavior.
 * - Cleanup removes only the exact unchanged staged file, then the exact
 *   still-owned root only while it is empty (plain `rmdir`, never recursive).
 *   Every deletion first re-verifies the canonical temporary parent's identity
 *   and that the root path still resolves to itself with no symlinked
 *   component. A modified, replaced, or foreign entry, and a moved, missing,
 *   or substituted root, parent, or ancestor, are preserved and reported as
 *   `false`. When the root or its parent was substituted, the staged entry is not released through the foreign path; on
 *   POSIX its continuity descriptor then stays open until process exit.
 * - Errors carry only a bounded reason; no path or prompt text is logged or
 *   included in a message.
 */

import { lstatSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { stageSessionHostPayload, type StagedSessionHostPayload } from "./payload";

export type NativeInitialPromptFailure = "invalid-prompt" | "unsafe-path" | "unavailable";

/** Bounded failure kind; the message never includes a path or prompt text. */
export class NativeInitialPromptError extends Error {
  readonly reason: NativeInitialPromptFailure;

  constructor(reason: NativeInitialPromptFailure) {
    super(`native initial prompt ${reason}`);
    this.name = "NativeInitialPromptError";
    this.reason = reason;
  }
}

export interface NativeInitialPromptLease {
  /** One printable line, suitable as a single argv operand after `--`. */
  readonly instruction: string;
  /** Owned staged file, for diagnostics and tests only; never log it with the prompt. */
  readonly filePath: string;
  /**
   * Releases this lease exactly once and memoizes the outcome. `true` only when
   * the exact owned file and root are now absent; `false` when anything was
   * preserved or could not be verified.
   */
  cleanup(): Promise<boolean>;
}

const ROOT_PREFIX = "prg-native-prompt-";
/**
 * UTF-16 code units per staged fragment: line framing, never a prompt limit.
 * Even when every code unit needs a six-character JSON escape, one fragment
 * line stays well under the common 2000-character per-line read bound of
 * native file readers, so no reader has to truncate a line.
 */
export const NATIVE_INITIAL_PROMPT_FRAGMENT_UNITS = 256;
/**
 * Code points that could alter terminal, argv, or line structure, or whose
 * rendering is ambiguous: controls, format (bidi) characters, surrogates,
 * private-use and unassigned code points, and every separator except U+0020.
 * `@` is refused too, so no native reader can mistake part of the generated
 * path for its own file-reference syntax.
 */
const UNSAFE_PATH_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}@]|[^\S ]/u;

interface PathIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

/** The owned root plus the canonical temporary parent it was created in. */
interface RootIdentity extends PathIdentity {
  readonly parent: PathIdentity;
}

/** Existing prompt admission: a nonempty string without NUL; no length cap. */
function isAdmissiblePrompt(prompt: unknown): prompt is string {
  return typeof prompt === "string" && prompt.length > 0 && !prompt.includes("\0");
}

function isRepresentablePath(path: string): boolean {
  return path.length > 0 && isAbsolute(path) && !UNSAFE_PATH_CHARACTER.test(path);
}

/**
 * Short single-line instruction; the path is a JSON string literal so quoting
 * is unambiguous. It starts with a plain word (never `/` or `@`) and tells the
 * reader to read every page, decode and concatenate every fragment in order
 * with no separators, and never act on a partial read.
 */
function buildInstruction(filePath: string): string {
  return `Please read the entire file at the JSON-quoted path ${JSON.stringify(filePath)}, `
    + "reading every page or line range until its end if it is long; never act on a partial read. "
    + "The file is one JSON array of strings: decode every string and concatenate them in order "
    + "with no separators, then carry out the resulting text exactly as my initial request.";
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * The exact staged file text of one admitted prompt: the canonical
 * pretty-printed JSON array (`JSON.stringify(fragments, null, 2)` plus one
 * trailing newline) of consecutive fragments of at most
 * {@link NATIVE_INITIAL_PROMPT_FRAGMENT_UNITS} code units. Concatenating the
 * decoded fragments in order with no separator yields the prompt exactly.
 */
export function encodeNativeInitialPromptFile(prompt: string): string {
  const fragments: string[] = [];
  let start = 0;
  while (start < prompt.length) {
    let end = Math.min(start + NATIVE_INITIAL_PROMPT_FRAGMENT_UNITS, prompt.length);
    // Keep a valid surrogate pair in one fragment; lone surrogates stay as they are.
    if (end < prompt.length && isHighSurrogate(prompt.charCodeAt(end - 1)) && isLowSurrogate(prompt.charCodeAt(end))) {
      end -= 1;
    }
    fragments.push(prompt.slice(start, end));
    start = end;
  }
  return `${JSON.stringify(fragments, null, 2)}\n`;
}

/**
 * Decodes one staged file text exactly, or `undefined` when it is not the
 * canonical encoding of an admissible prompt. For verification only: the
 * native session reads the file itself.
 */
export function decodeNativeInitialPromptFile(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((fragment) => typeof fragment === "string")) {
    return undefined;
  }
  const prompt = (parsed as string[]).join("");
  if (!isAdmissiblePrompt(prompt) || encodeNativeInitialPromptFile(prompt) !== text) return undefined;
  return prompt;
}

type RootState = "intact" | "missing" | "changed";

function isSameDirectory(identity: PathIdentity): boolean {
  try {
    const stats = lstatSync(identity.path, { bigint: true });
    return stats.isDirectory() && !stats.isSymbolicLink() && stats.dev === identity.dev && stats.ino === identity.ino;
  } catch {
    return false;
  }
}

/** True only while the path still resolves to itself through no symlinked component. */
function isCanonical(path: string): boolean {
  try {
    return realpathSync(path) === path;
  } catch {
    return false;
  }
}

/**
 * The root is intact only while its canonical parent is the same real
 * directory, the root path resolves to itself through no symlinked or
 * substituted ancestor, and the root inode is the one this lease created. A
 * substituted parent or ancestor is `changed`, never `missing`.
 */
function inspectRoot(root: RootIdentity): RootState {
  if (!isSameDirectory(root.parent) || !isCanonical(root.parent.path)) return "changed";
  try {
    lstatSync(root.path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "changed";
  }
  return isSameDirectory(root) && isCanonical(root.path) ? "intact" : "changed";
}

function isAbsent(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Removes the exact still-owned root only while empty; true when it is now absent. */
function removeOwnedEmptyRoot(root: RootIdentity): boolean {
  if (inspectRoot(root) !== "intact") return false;
  try {
    rmdirSync(root.path);
  } catch {
    // Nonempty (a preserved or foreign entry), busy, or raced: preserve.
    return false;
  }
  return isAbsent(root.path);
}

/**
 * Stages the exact prompt in a fresh owned private namespace and returns the
 * generated instruction plus its idempotent ownership-checked cleanup.
 * Throws {@link NativeInitialPromptError} before writing the prompt when it is
 * inadmissible or when the owned path cannot be represented safely.
 */
export function prepareNativeInitialPrompt(prompt: string): NativeInitialPromptLease {
  if (!isAdmissiblePrompt(prompt)) throw new NativeInitialPromptError("invalid-prompt");
  let root: RootIdentity | undefined;
  let staged: StagedSessionHostPayload | undefined;
  try {
    const parentPath = realpathSync(tmpdir());
    const parentStats = lstatSync(parentPath, { bigint: true });
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) throw new NativeInitialPromptError("unavailable");
    const parent: PathIdentity = { path: parentPath, dev: parentStats.dev, ino: parentStats.ino };
    const created = mkdtempSync(join(parentPath, ROOT_PREFIX));
    const createdStats = lstatSync(created, { bigint: true });
    if (!createdStats.isDirectory() || createdStats.isSymbolicLink()) throw new NativeInitialPromptError("unavailable");
    root = { path: created, dev: createdStats.dev, ino: createdStats.ino, parent };
    if (inspectRoot(root) !== "intact") throw new NativeInitialPromptError("unsafe-path");
    // The staged basename is fixed-alphabet; check the root before any prompt byte is written.
    if (!isRepresentablePath(root.path)) throw new NativeInitialPromptError("unsafe-path");
    staged = stageSessionHostPayload(root.path, encodeNativeInitialPromptFile(prompt), {
      dev: root.dev.toString(),
      ino: root.ino.toString(),
    });
    const filePath = join(root.path, staged.descriptor.name);
    const instruction = buildInstruction(filePath);
    if (!isRepresentablePath(filePath)) throw new NativeInitialPromptError("unsafe-path");
    const ownedRoot = root;
    const ownedStaged = staged;
    let outcome: Promise<boolean> | undefined;
    return Object.freeze({
      instruction,
      filePath,
      cleanup: (): Promise<boolean> => {
        outcome ??= Promise.resolve().then(() => releaseLease(ownedRoot, filePath, ownedStaged));
        return outcome;
      },
    });
  } catch (error) {
    // Release through the owned path only while root and parent are intact.
    if (staged !== undefined && root !== undefined && inspectRoot(root) !== "changed") staged.discard();
    if (root !== undefined) removeOwnedEmptyRoot(root);
    if (error instanceof NativeInitialPromptError) throw error;
    throw new NativeInitialPromptError("unavailable");
  }
}

function releaseLease(
  root: RootIdentity,
  filePath: string,
  staged: StagedSessionHostPayload,
): boolean {
  const state = inspectRoot(root);
  if (state === "changed") {
    // A substituted root, parent, or ancestor is foreign: never act through
    // it, even on an entry that still reports the owned inode.
    return false;
  }
  try {
    // Removes only the exact unchanged pinned inode and releases its pin. With
    // the root missing, no entry can be reached and only the pin is released.
    staged.discard();
  } catch {
    return false;
  }
  // A moved or missing root may still hold the owned file elsewhere: unverifiable.
  if (state === "missing") return false;
  if (!isAbsent(filePath)) return false;
  return removeOwnedEmptyRoot(root);
}
