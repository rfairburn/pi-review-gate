import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWrite } from "./durable-write";

export const PI_QUIESCENCE_SECRET_ENV = "PI_REVIEW_GATE_QUIESCENCE_SECRET";
export const PI_QUIESCENCE_PATH_ENV = "PI_REVIEW_GATE_QUIESCENCE_PATH";
export const PI_QUIESCENCE_SESSION_ENV = "PI_REVIEW_GATE_QUIESCENCE_SESSION";
export const PI_QUIESCENCE_CHILD_ENV = "PI_REVIEW_GATE_QUIESCENCE_CHILD";

const RECEIPT_VERSION = 1;
const MAX_RECEIPT_BYTES = 2_048;
const TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

export interface PiQuiescenceBootstrap {
  path: string;
  sessionId: string;
  childId: string;
  secret: string;
  pid?: number;
}

interface PiQuiescenceReceipt {
  version: number;
  sessionId: string;
  childId: string;
  settlement: number;
  pid: number;
  mac: string;
}

/** Parent-side creation of a fresh acknowledgement identity for one child. */
export function createPiQuiescenceBootstrap(artifactDir: string, sessionId: string): PiQuiescenceBootstrap {
  const childId = randomBytes(24).toString("base64url");
  return {
    path: join(resolve(artifactDir), "executor-acks", `${childId}.json`),
    sessionId,
    childId,
    secret: randomBytes(32).toString("base64url"),
  };
}

export function piQuiescenceEnvironment(bootstrap: PiQuiescenceBootstrap): NodeJS.ProcessEnv {
  return {
    [PI_QUIESCENCE_SECRET_ENV]: bootstrap.secret,
    [PI_QUIESCENCE_PATH_ENV]: bootstrap.path,
    [PI_QUIESCENCE_SESSION_ENV]: bootstrap.sessionId,
    [PI_QUIESCENCE_CHILD_ENV]: bootstrap.childId,
  };
}

/**
 * Child-side one-shot bootstrap capture. Environment entries are removed
 * before validation so model tools and their subprocesses cannot inherit the
 * signing material even when bootstrap data is malformed.
 */
export function capturePiQuiescenceBootstrap(env: NodeJS.ProcessEnv = process.env): PiQuiescenceBootstrap | undefined {
  const secret = env[PI_QUIESCENCE_SECRET_ENV];
  const path = env[PI_QUIESCENCE_PATH_ENV];
  const sessionId = env[PI_QUIESCENCE_SESSION_ENV];
  const childId = env[PI_QUIESCENCE_CHILD_ENV];
  delete env[PI_QUIESCENCE_SECRET_ENV];
  delete env[PI_QUIESCENCE_PATH_ENV];
  delete env[PI_QUIESCENCE_SESSION_ENV];
  delete env[PI_QUIESCENCE_CHILD_ENV];
  if ([secret, path, sessionId, childId].every((value) => value === undefined)) return undefined;
  if (
    !secret || !path || !sessionId || !childId
    || !TOKEN.test(secret) || !TOKEN.test(childId)
    || sessionId.length > 200
  ) {
    throw new Error("Pi executor quiescence bootstrap is malformed.");
  }
  const expectedSuffix = join("executor-acks", `${childId}.json`);
  if (!resolve(path).endsWith(expectedSuffix)) throw new Error("Pi executor quiescence receipt path is invalid.");
  return { path: resolve(path), sessionId, childId, secret, pid: process.pid };
}

/** Publish only after the child extension's browser barrier succeeds. */
export async function publishPiQuiescenceReceipt(
  bootstrap: PiQuiescenceBootstrap,
  settlement: number,
): Promise<void> {
  assertSettlement(settlement);
  const pid = bootstrap.pid ?? process.pid;
  const unsigned = { version: RECEIPT_VERSION, sessionId: bootstrap.sessionId, childId: bootstrap.childId, settlement, pid };
  const receipt: PiQuiescenceReceipt = { ...unsigned, mac: receiptMac(bootstrap.secret, unsigned) };
  const body = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw new Error("Pi executor quiescence receipt exceeds its bound.");
  await atomicWrite(bootstrap.path, body);
}

/**
 * Verify one exact child/session/settlement acknowledgement and consume it.
 * Missing receipts are retried only inside the caller-provided finite window;
 * malformed or mismatched records fail immediately and closed.
 */
export async function awaitPiQuiescenceReceipt(
  bootstrap: PiQuiescenceBootstrap,
  afterSettlement: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isSafeInteger(afterSettlement) || afterSettlement < 0) {
    throw new Error("Pi executor prior settlement generation is invalid.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Pi quiescence acknowledgement timeout is invalid.");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Pi executor acknowledgement was cancelled.");
    try {
      const stat = await lstat(bootstrap.path);
      if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RECEIPT_BYTES) {
        throw new Error("Pi executor quiescence acknowledgement is malformed.");
      }
      const raw = await readFile(bootstrap.path);
      if (raw.byteLength > MAX_RECEIPT_BYTES) throw new Error("Pi executor quiescence acknowledgement is oversized.");
      const receipt = parseReceipt(raw.toString("utf8"));
      verifyReceipt(receipt, bootstrap, afterSettlement);
      await unlink(bootstrap.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return receipt.settlement;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        await unlink(bootstrap.path).catch(() => undefined);
        throw error;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Pi executor quiescence acknowledgement was not received before its bounded deadline.");
    await delay(Math.min(20, remaining), signal);
  }
}

export async function removePiQuiescenceReceipt(bootstrap: PiQuiescenceBootstrap): Promise<void> {
  await unlink(bootstrap.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function parseReceipt(raw: string): PiQuiescenceReceipt {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Pi executor quiescence acknowledgement is malformed."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi executor quiescence acknowledgement is malformed.");
  const receipt = value as Record<string, unknown>;
  if (
    Object.keys(receipt).length !== 6
    || receipt.version !== RECEIPT_VERSION
    || typeof receipt.sessionId !== "string"
    || typeof receipt.childId !== "string"
    || !Number.isSafeInteger(receipt.settlement)
    || !Number.isSafeInteger(receipt.pid)
    || typeof receipt.mac !== "string"
  ) throw new Error("Pi executor quiescence acknowledgement is malformed.");
  return receipt as unknown as PiQuiescenceReceipt;
}

function verifyReceipt(receipt: PiQuiescenceReceipt, bootstrap: PiQuiescenceBootstrap, afterSettlement: number): void {
  if (
    receipt.sessionId !== bootstrap.sessionId
    || receipt.childId !== bootstrap.childId
    || receipt.settlement <= afterSettlement
    || receipt.pid !== bootstrap.pid
  ) throw new Error("Pi executor quiescence acknowledgement does not match this child/session/settlement.");
  const unsigned = {
    version: receipt.version,
    sessionId: receipt.sessionId,
    childId: receipt.childId,
    settlement: receipt.settlement,
    pid: receipt.pid,
  };
  const expected = Buffer.from(receiptMac(bootstrap.secret, unsigned), "base64url");
  if (!/^[A-Za-z0-9_-]{43}$/.test(receipt.mac)) {
    throw new Error("Pi executor quiescence acknowledgement signature is malformed.");
  }
  const actual = Buffer.from(receipt.mac, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error("Pi executor quiescence acknowledgement signature is invalid.");
  }
}

function receiptMac(
  masterSecret: string,
  receipt: Omit<PiQuiescenceReceipt, "mac">,
): string {
  // A generation-specific key makes each acknowledgement one-shot even
  // though one Pi RPC process can settle several resumed turns.
  const oneShot = createHmac("sha256", masterSecret)
    .update(`pi-review-gate-quiescence-key:v1:${receipt.settlement}`)
    .digest();
  return createHmac("sha256", oneShot)
    .update(JSON.stringify([receipt.version, receipt.sessionId, receipt.childId, receipt.settlement, receipt.pid]))
    .digest("base64url");
}

function assertSettlement(settlement: number): void {
  if (!Number.isSafeInteger(settlement) || settlement < 1) throw new Error("Pi executor settlement generation is invalid.");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    timer.unref?.();
    if (!signal) return;
    onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Pi executor acknowledgement was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}