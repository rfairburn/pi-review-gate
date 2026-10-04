/** Canonical JSON identity: safe positive numbers retain their historical encoding;
 * larger unsigned 64-bit values use decimal strings, never rounded Numbers. */
export type SourceIdentityComponent = number | string;

/** Immutable filesystem device/volume and inode identity of the source root. */
export interface SourceIdentity {
  /** Device or volume ID of the filesystem containing the root. */
  dev: SourceIdentityComponent;
  /** Inode number of the root directory. */
  ino: SourceIdentityComponent;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_UINT64 = 18446744073709551615n;

export function isSourceIdentityComponent(value: unknown): value is SourceIdentityComponent {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  // Bound length before grammar/parsing: never parse arbitrary-size decimal input.
  if (typeof value !== "string" || value.length > 20 || !/^[1-9][0-9]{0,19}$/.test(value)) return false;
  const exact = BigInt(value);
  return exact > MAX_SAFE && exact <= MAX_UINT64;
}

export function isSourceIdentity(value: unknown): value is SourceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return isSourceIdentityComponent(identity.dev) && isSourceIdentityComponent(identity.ino);
}

export function encodeSourceIdentityComponent(value: bigint): SourceIdentityComponent {
  if (typeof value !== "bigint" || value <= 0n || value > MAX_UINT64) throw new Error("Source root identity component is not a positive unsigned 64-bit integer.");
  return value <= MAX_SAFE ? Number(value) : value.toString(10);
}

/** Canonical components allow strict equality across capture, JSON reload and recovery. */
export function sourceIdentitiesEqual(left: unknown, right: unknown): boolean {
  return isSourceIdentity(left) && isSourceIdentity(right)
    && left.dev === right.dev && left.ino === right.ino;
}
