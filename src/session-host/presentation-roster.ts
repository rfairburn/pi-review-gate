/**
 * Canonical mixed local/remote presentation roster (pure model).
 *
 * The session host's sidebar order is ONE insertion-ordered sequence that
 * already mixes local remembered slots with remote session cards. This module
 * is the single authority for that sequence: one internal `Map` whose iteration
 * order IS the canonical presentation order, holding either a local record (the
 * local truth, exactly as Main's remembered roster records carry it) or a
 * remote presentation identity (durable presentation identity ONLY — never
 * cached remote roster facts, never a runtime row map, never an action or
 * input target).
 *
 * Deliberate invariants:
 *
 * - There is exactly one ordered store. No second ordered key list, no index
 *   mirror, no sort pass: ordered views are DERIVED from the canonical map on
 *   every read, so nothing can drift out of sync.
 * - Keys are kind-qualified JSON tuples, so a local slot id can never collide
 *   with a remote identity, a remote identity on one host can never collide
 *   with the same owner id on another host, and a durable remote slot can never
 *   collide with a legacy runtime row id — including ids that contain the
 *   separator, quotes, backslashes, control characters, or supplementary
 *   Unicode.
 * - A local entry's identity is DERIVED from its record (`slotId`), never
 *   duplicated beside it in the canonical value.
 * - Payload mutability is preserved: a local record is stored by reference so
 *   existing in-place record updates keep working. Identity snapshots handed out
 *   are frozen copies, so a caller cannot mutate the roster's own identities.
 * - First observation of an identity appends; an already-present identity is
 *   never moved, re-appended, or reordered by a matching return.
 * - Absence is retained: a remembered remote identity stays in the canonical
 *   sequence when no row currently matches it, and this model never invents a
 *   display row, an expiry, or a cleanup pass for it.
 *
 * Out of scope by design: persistence, IO, schema, configuration, sorting,
 * grouping, pinning, user reset, lifecycle, and any UI move-mode or drag
 * behavior. Movement here is only an explicit source + target + before/after
 * request on identities that already exist in the sequence.
 */

/**
 * Presentation identity of one local remembered sidebar slot. `slotId` is the
 * stable local slot key: native `/new`, `/resume`, and a regenerated manager
 * row all keep the same slot identity and therefore the same position.
 */
export interface LocalPresentationIdentity {
  readonly kind: "local";
  readonly slotId: string;
}

/**
 * Owner side of a remote presentation identity. `slot` is the durable remote
 * slot identity; `runtime` is a legacy owner-side runtime row identity. They
 * are deliberately distinct: a regenerated runtime row id is a NEW appended
 * entry, never a guess that rewrites a durable one.
 */
export type RemotePresentationOwnerKind = "slot" | "runtime";

/** One owner-side remote identity component. */
export interface RemotePresentationOwner {
  readonly kind: RemotePresentationOwnerKind;
  readonly id: string;
}

/**
 * Presentation identity of one remote session card. It carries ONLY durable
 * presentation identity: no run id, no subscription, no input/action tuple, and
 * no roster facts, because those are not presentation order authority.
 */
export interface RemotePresentationIdentity {
  readonly kind: "remote";
  readonly hostId: string;
  readonly owner: RemotePresentationOwner;
}

/** The closed set of presentation identities this roster can order. */
export type PresentationIdentity = LocalPresentationIdentity | RemotePresentationIdentity;

/** The minimum a local record must carry: its stable slot key. */
export interface PresentationLocalRecord {
  readonly slotId: string;
}

/**
 * Derived local view of one canonical entry. The identity is projected FROM the
 * record; it is not a second stored copy of `slotId`.
 */
export interface LocalPresentationEntry<T extends PresentationLocalRecord> {
  readonly kind: "local";
  readonly identity: LocalPresentationIdentity;
  /** The canonical local record itself (by reference, payload mutable). */
  readonly record: T;
}

/** Derived remote view of one canonical entry: identity only. */
export interface RemotePresentationEntry {
  readonly kind: "remote";
  readonly identity: RemotePresentationIdentity;
}

/** The closed set of ordered entry views this roster projects. */
export type PresentationEntry<T extends PresentationLocalRecord> =
  | LocalPresentationEntry<T>
  | RemotePresentationEntry;

/** Direction of one explicit move request. */
export type PresentationMovePosition = "before" | "after";

/** Canonical local value: identity is derived from `record.slotId`. */
type CanonicalLocalValue<T extends PresentationLocalRecord> = {
  readonly kind: "local";
  readonly record: T;
};

/** Canonical remote value: durable presentation identity, nothing else. */
type CanonicalRemoteValue = {
  readonly kind: "remote";
  readonly identity: RemotePresentationIdentity;
};

type CanonicalValue<T extends PresentationLocalRecord> =
  | CanonicalLocalValue<T>
  | CanonicalRemoteValue;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Kind-qualified injective key. `JSON.stringify` escapes quotes, backslashes,
 * and control characters, so no id content can forge a boundary between tuple
 * elements or impersonate the other kind.
 */
function localKeyOf(slotId: string): string {
  return JSON.stringify(["local", slotId]);
}

function remoteKeyOf(hostId: string, ownerKind: RemotePresentationOwnerKind, ownerId: string): string {
  return JSON.stringify(["remote", hostId, ownerKind, ownerId]);
}

/**
 * Validate one caller-supplied identity and return an independent snapshot, or
 * `undefined` for anything this model cannot order. Unknown `kind` values,
 * empty ids, and a missing or malformed remote owner are refused; nothing is
 * guessed, coerced, or aliased.
 */
function snapshotIdentity(identity: PresentationIdentity | undefined): PresentationIdentity | undefined {
  if (typeof identity !== "object" || identity === null) return undefined;
  const candidate = identity as {
    kind?: unknown;
    slotId?: unknown;
    hostId?: unknown;
    owner?: unknown;
  };
  if (candidate.kind === "local") {
    return isNonEmptyString(candidate.slotId)
      ? Object.freeze({ kind: "local" as const, slotId: candidate.slotId })
      : undefined;
  }
  if (candidate.kind === "remote") {
    const owner = candidate.owner as { kind?: unknown; id?: unknown } | null | undefined;
    if (!isNonEmptyString(candidate.hostId) || typeof owner !== "object" || owner === null) return undefined;
    if (owner.kind !== "slot" && owner.kind !== "runtime") return undefined;
    if (!isNonEmptyString(owner.id)) return undefined;
    return Object.freeze({
      kind: "remote" as const,
      hostId: candidate.hostId,
      owner: Object.freeze({ kind: owner.kind as RemotePresentationOwnerKind, id: owner.id }),
    });
  }
  return undefined;
}

function keyOfIdentity(identity: PresentationIdentity): string {
  return identity.kind === "local"
    ? localKeyOf(identity.slotId)
    : remoteKeyOf(identity.hostId, identity.owner.kind, identity.owner.id);
}

function keyOfValue<T extends PresentationLocalRecord>(value: CanonicalValue<T>): string {
  return value.kind === "local"
    ? localKeyOf(value.record.slotId)
    : remoteKeyOf(value.identity.hostId, value.identity.owner.kind, value.identity.owner.id);
}

function localIdentityOf<T extends PresentationLocalRecord>(record: T): LocalPresentationIdentity {
  return Object.freeze({ kind: "local" as const, slotId: record.slotId });
}

/** Interpret one hydrated entry as a canonical value, or refuse it. */
function canonicalValueOfEntry<T extends PresentationLocalRecord>(
  entry: PresentationEntry<T> | undefined,
): CanonicalValue<T> | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const candidate = entry as { kind?: unknown; record?: unknown; identity?: unknown };
  if (candidate.kind === "local") {
    const record = candidate.record as T | undefined;
    if (typeof record !== "object" || record === null || !isNonEmptyString(record.slotId)) return undefined;
    return { kind: "local", record };
  }
  if (candidate.kind === "remote") {
    const identity = snapshotIdentity(candidate.identity as RemotePresentationIdentity | undefined);
    return identity !== undefined && identity.kind === "remote"
      ? { kind: "remote", identity }
      : undefined;
  }
  return undefined;
}

/**
 * One canonical insertion-ordered mixed local/remote presentation sequence.
 *
 * The map's own iteration order is the presentation order; every ordered view
 * is derived from it at read time. Local entries carry the canonical local
 * record; remote entries carry durable presentation identity only.
 */
export class PresentationRoster<T extends PresentationLocalRecord> {
  /** The one canonical store: key -> local record or remote identity, in presentation order. */
  private readonly canonical = new Map<string, CanonicalValue<T>>();

  /** Number of entries in the canonical sequence. */
  get size(): number {
    return this.canonical.size;
  }

  /** True when this identity already occupies a position in the sequence. */
  has(identity: PresentationIdentity): boolean {
    const snapshot = snapshotIdentity(identity);
    return snapshot !== undefined && this.canonical.has(keyOfIdentity(snapshot));
  }

  /**
   * Opaque canonical key of a present identity, `undefined` when absent. The
   * key is a lookup handle for this instance only: it is never persisted,
   * parsed, compared across instances, or treated as presentation data.
   */
  keyOf(identity: PresentationIdentity): string | undefined {
    const snapshot = snapshotIdentity(identity);
    if (snapshot === undefined) return undefined;
    const key = keyOfIdentity(snapshot);
    return this.canonical.has(key) ? key : undefined;
  }

  /** The canonical local record for one slot, `undefined` when unremembered. */
  getLocal(slotId: string): T | undefined {
    if (!isNonEmptyString(slotId)) return undefined;
    const value = this.canonical.get(localKeyOf(slotId));
    return value !== undefined && value.kind === "local" ? value.record : undefined;
  }

  /**
   * Remember or update one local record. A new slot appends at the end; an
   * existing slot keeps its exact position and only its payload changes. The
   * record is stored by reference so existing in-place record updates stay
   * visible. Refuses (no change) when the record carries no usable slot id.
   */
  setLocal(record: T): boolean {
    if (typeof record !== "object" || record === null || !isNonEmptyString(record.slotId)) return false;
    this.canonical.set(localKeyOf(record.slotId), { kind: "local", record });
    return true;
  }

  /** Remove one local record. Returns whether anything was removed. */
  deleteLocal(slotId: string): boolean {
    if (!isNonEmptyString(slotId)) return false;
    const value = this.canonical.get(localKeyOf(slotId));
    if (value === undefined || value.kind !== "local") return false;
    return this.canonical.delete(localKeyOf(slotId));
  }

  /**
   * First observation of one remote presentation identity appends it once.
   * A matching return of an already-present identity changes nothing at all:
   * no re-append, no move to the host's bottom, no cached remote facts.
   * Refuses (no change) on a malformed identity.
   */
  rememberRemote(identity: RemotePresentationIdentity): boolean {
    const snapshot = snapshotIdentity(identity);
    if (snapshot === undefined || snapshot.kind !== "remote") return false;
    const key = keyOfIdentity(snapshot);
    if (this.canonical.has(key)) return false;
    this.canonical.set(key, { kind: "remote", identity: snapshot });
    return true;
  }

  /** Ordered identities of every canonical entry, local and remote. */
  identities(): readonly PresentationIdentity[] {
    const out: PresentationIdentity[] = [];
    for (const value of this.canonical.values()) {
      out.push(value.kind === "local" ? localIdentityOf(value.record) : value.identity);
    }
    return out;
  }

  /** Ordered entry views of every canonical entry, local and remote. */
  entries(): readonly PresentationEntry<T>[] {
    const out: PresentationEntry<T>[] = [];
    for (const value of this.canonical.values()) {
      out.push(value.kind === "local"
        ? Object.freeze({ kind: "local" as const, identity: localIdentityOf(value.record), record: value.record })
        : Object.freeze({ kind: "remote" as const, identity: value.identity }));
    }
    return out;
  }

  /** Ordered local entry views; remote entries are simply not included. */
  localEntries(): readonly LocalPresentationEntry<T>[] {
    const out: LocalPresentationEntry<T>[] = [];
    for (const value of this.canonical.values()) {
      if (value.kind !== "local") continue;
      out.push(Object.freeze({ kind: "local" as const, identity: localIdentityOf(value.record), record: value.record }));
    }
    return out;
  }

  /** Ordered canonical local records (by reference, payload mutable). */
  localRecords(): readonly T[] {
    const out: T[] = [];
    for (const value of this.canonical.values()) {
      if (value.kind === "local") out.push(value.record);
    }
    return out;
  }

  /**
   * Move one present identity to sit immediately before or after another
   * present identity. Movement is host-independent: any entry may move past any
   * other regardless of kind or host. There is no wrapping, no alias
   * resolution, and no implicit insertion — a missing or malformed source or
   * target, a source and target that are the same identity, or a direction
   * outside `before`/`after` refuses with `false` and leaves the sequence
   * exactly as it was.
   */
  move(
    source: PresentationIdentity,
    target: PresentationIdentity,
    position: PresentationMovePosition,
  ): boolean {
    if (position !== "before" && position !== "after") return false;
    const sourceSnapshot = snapshotIdentity(source);
    const targetSnapshot = snapshotIdentity(target);
    if (sourceSnapshot === undefined || targetSnapshot === undefined) return false;
    const sourceKey = keyOfIdentity(sourceSnapshot);
    const targetKey = keyOfIdentity(targetSnapshot);
    if (sourceKey === targetKey) return false;
    if (!this.canonical.has(sourceKey) || !this.canonical.has(targetKey)) return false;

    const pairs = [...this.canonical.entries()];
    const sourceIndex = pairs.findIndex(([key]) => key === sourceKey);
    if (sourceIndex < 0) return false;
    const moved = pairs[sourceIndex][1];
    pairs.splice(sourceIndex, 1);
    const targetIndex = pairs.findIndex(([key]) => key === targetKey);
    if (targetIndex < 0) return false;
    pairs.splice(position === "before" ? targetIndex : targetIndex + 1, 0, [sourceKey, moved]);

    // Rebuild the one canonical map in place; no second order store exists.
    this.canonical.clear();
    for (const [key, value] of pairs) this.canonical.set(key, value);
    return true;
  }

  /**
   * Replace the whole canonical sequence from ordered entry views (the shape
   * {@link PresentationRoster.entries} produces). Validation is total before
   * any mutation: a malformed entry, a remote entry without a durable
   * identity, or a duplicate identity in the input refuses the whole hydration
   * and leaves the sequence exactly as it was. Local records are adopted by
   * reference, so a caller keeping its own record objects stays authoritative
   * for them.
   */
  hydrate(entries: readonly PresentationEntry<T>[]): boolean {
    if (!Array.isArray(entries)) return false;
    const rebuilt = new Map<string, CanonicalValue<T>>();
    for (const entry of entries) {
      const value = canonicalValueOfEntry<T>(entry);
      if (value === undefined) return false;
      const key = keyOfValue(value);
      if (rebuilt.has(key)) return false;
      rebuilt.set(key, value);
    }
    this.canonical.clear();
    for (const [key, value] of rebuilt) this.canonical.set(key, value);
    return true;
  }
}
