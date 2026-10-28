/** Delete only recorded Pi sessions when an existing artifact cleanup selects their owner. */
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readBoundedTextFile } from "../bounded-file";
import { isValidNativeSessionFile } from "../session-host/protocol";
import { readSavedSessionHeader } from "../session-host/saved-sessions";

export const MAX_CLEANUP_REFUSALS = 8; // Display limit only; never limits deletion or collection.
export interface NativeSessionCleanup { deleted: number; refused: string[] }
interface NativeSessionRef { id: string; file: string }
export function nothingCleaned(): NativeSessionCleanup {
  return { deleted: 0, refused: [] };
}

async function readMetadata(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    if (!(await lstat(path)).isFile() || await realpath(path) !== path) return undefined;
    const parsed: unknown = JSON.parse((await readBoundedTextFile(path, 64 * 1024)).text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

async function directories(path: string): Promise<string[]> {
  try {
    if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) return [];
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

// Expand only these fixed metadata layouts, never a workspace or a shared session store.
const layouts = [
  ["operation.json"],
  ["executor", "*", "process-result.json"],
  ["reviews", "*", "reviewers", "*", "invocation.json"],
  ["questions", "*", "reviewers", "*", "invocation.json"],
];
async function* metadataFiles(root: string, parts: string[]): AsyncGenerator<string> {
  if (parts.length === 0) { yield root; return; }
  const [part, ...rest] = parts;
  const children = part === "*" ? await directories(root) : [join(root, part!)];
  for (const child of children) yield* metadataFiles(child, rest);
}

async function recordedRefs(root: string): Promise<NativeSessionRef[]> {
  const refs = new Map<string, NativeSessionRef>();
  for (const owner of [root, ...await directories(join(root, "artifacts"))]) {
    for (const layout of layouts) {
      for await (const path of metadataFiles(owner, layout)) {
        const record = await readMetadata(path);
        const session = record?.session && typeof record.session === "object"
          ? record.session as Record<string, unknown> : record;
        if (session?.adapter !== "pi-model") continue;
        const id = session.id ?? session.sessionId;
        const file = session.file ?? session.sessionFile;
        if (typeof id === "string" && typeof file === "string") refs.set(id, { id, file });
      }
    }
  }
  return [...refs.values()];
}

/** Identity work is bounded to the first header, independent of transcript length. */
async function unlinkVerifiedSession(ref: NativeSessionRef): Promise<string | undefined> {
  if (!isValidNativeSessionFile(ref.file)) return "Recorded native Pi session path is invalid";
  try {
    if (!(await lstat(ref.file)).isFile()) return `${ref.file} is not a regular file`;
    const header = readSavedSessionHeader(ref.file);
    if (!header) return `${ref.file} has no verifiable bounded session header`;
    if (header.id !== ref.id) return `${ref.file} records a different session id`;
    await unlink(ref.file);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? undefined : `${ref.file} could not be removed (${code ?? "error"})`;
  }
}

export async function deleteRecordedNativeSessions(root: string): Promise<NativeSessionCleanup> {
  const result = nothingCleaned();
  const info = await lstat(root).catch(() => undefined);
  if (!info) return result;
  if (!info.isDirectory()) return { deleted: 0, refused: [`${root} is not a real artifact directory`] };
  const canonicalRoot = await realpath(root).catch(() => undefined);
  if (!canonicalRoot) return { deleted: 0, refused: [`${root} could not be resolved`] };
  for (const ref of await recordedRefs(canonicalRoot)) {
    const refusal = await unlinkVerifiedSession(ref);
    if (refusal === undefined) result.deleted += 1;
    else result.refused.push(refusal);
  }
  return result;
}

export async function deleteRecordedNativeSession(
  session: { id?: string; file?: string } | undefined,
): Promise<{ deleted: boolean; refusal?: string }> {
  if (!session?.id || !session.file) return { deleted: false };
  const refusal = await unlinkVerifiedSession({ id: session.id, file: session.file });
  return refusal === undefined ? { deleted: true } : { deleted: false, refusal };
}
