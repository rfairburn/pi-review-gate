import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isValidNativeSessionId } from "./protocol";

export type NativePersistence = "saved" | "unsaved" | "unknown";
export interface NativePersistenceReceipt {
  readonly sessionId: string;
  readonly persistence: NativePersistence;
}

export function parseNativePersistenceReceipt(value: unknown): NativePersistenceReceipt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (!isValidNativeSessionId(record.sessionId)
    || !["saved", "unsaved", "unknown"].includes(record.persistence as string)) return undefined;
  return { sessionId: record.sessionId, persistence: record.persistence as NativePersistence };
}

/** Inspect exactly the public SessionManager planned file, never a directory scan or file content. */
export function probeNativeSessionFile(file: unknown): NativePersistence {
  if (typeof file !== "string" || !isAbsolute(file) || Buffer.byteLength(file, "utf8") > 2048
    || /[\x00-\x1f\x7f\u0080-\u009f]/.test(file)) return "unknown";
  try {
    const stat = lstatSync(file, { bigint: true });
    return stat.isFile() && !stat.isSymbolicLink() ? "saved" : "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "unsaved" : "unknown";
  }
}

/** Missing/throwing APIs are unknown; successful undefined means the documented in-memory manager. */
export function readNativePersistence(
  context: unknown,
  expectedSessionId: string,
  probe: (file: unknown) => NativePersistence = probeNativeSessionFile,
): NativePersistence {
  try {
    if (typeof context !== "object" || context === null) return "unknown";
    const manager = (context as { sessionManager?: unknown }).sessionManager;
    if (typeof manager !== "object" || manager === null) return "unknown";
    const source = manager as Record<string, unknown>;
    const getId = source.getSessionId;
    const getFile = source.getSessionFile;
    if (typeof getId !== "function" || typeof getFile !== "function"
      || getId.call(manager) !== expectedSessionId) return "unknown";
    const file: unknown = getFile.call(manager);
    const result = file === undefined ? "unsaved" : probe(file);
    return getId.call(manager) === expectedSessionId ? result : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * A previously observed saved binding never becomes "never saved" merely
 * because its file was subsequently removed or made unreadable. A native
 * rebind starts a different receipt; reload can restore the same receipt.
 */
export class NativePersistenceTracker {
  private receipt?: NativePersistenceReceipt;

  constructor(restored?: NativePersistenceReceipt) {
    this.receipt = parseNativePersistenceReceipt(restored);
  }

  observe(sessionId: string, observed: NativePersistence): NativePersistenceReceipt | undefined {
    if (!isValidNativeSessionId(sessionId)) return undefined;
    const knownSaved = this.receipt?.sessionId === sessionId && this.receipt.persistence === "saved";
    const persistence = knownSaved ? "saved" : observed;
    this.receipt = { sessionId, persistence };
    return { ...this.receipt };
  }

  snapshot(): NativePersistenceReceipt | undefined {
    return this.receipt ? { ...this.receipt } : undefined;
  }
}
