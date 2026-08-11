import { open } from "node:fs/promises";

export interface BoundedTextFile {
  text: string;
  truncated: boolean;
}

/** Read at most maxBytes of a UTF-8 file without allocating from its full size. */
export async function readBoundedTextFile(path: string, maxBytes: number): Promise<BoundedTextFile> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return {
      text: buffer.subarray(0, Math.min(offset, maxBytes)).toString("utf8"),
      truncated: offset > maxBytes,
    };
  } finally {
    await handle.close();
  }
}
