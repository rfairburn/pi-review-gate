/**
 * The shared NATIVE STATUS APPLICABILITY contract (issue #277 native status slice).
 *
 * One hosted provider row can legitimately be unable to report one category of
 * sidebar state. This module keeps that fact a DATA value instead of a sentinel: a
 * category is either declared `supported`, declared `unsupported`, or left
 * undeclared, and the row's OBSERVED value for a category keeps the existing
 * `boolean | null` / `number | null` shape. Nothing here encodes "cannot report"
 * as `false`, `0`, `null`, or a string inside a value field, so:
 *
 * - `unsupported` renders as not-applicable and can never be read as zero or idle;
 * - a supported category whose value is `null` renders as unknown, exactly as an
 *   unobserved Pi row does;
 * - an UNDECLARED category stays supported-and-unknown, so a row (or a peer) that
 *   never carried this metadata keeps its exact legacy behavior and never gains
 *   not-applicable rendering by accident.
 *
 * The categories are the sidebar's own facts, not provider vocabulary: `agent`
 * (the agent state), `input` (a real pending native question), `tasks` and
 * `shells` (the provider harness's OWN background subtasks and background shell
 * jobs), and `activity` (the current/last activity lines). A native `tasks` or
 * `shells` count describes that provider's harness jobs and NOTHING of this host's
 * own execution, review, or background-shell sources; the native observation type
 * has no ownership-count field at all, so a provider number can never enter the
 * conservative stop/idle channel.
 *
 * This file is a pure contract: no IO, no timers, no process, no provider code, no
 * rendering. The owner-side sink and the remote roster boundary read through the
 * same validators, and the sidebar classifies through the same helper, so a local
 * row, a paired-owner row, the drawn card, and the plain Network activity summary
 * cannot disagree about what a declaration means.
 */

import { isRecord } from "../record-guard";

/** The closed set of sidebar categories a native observer may declare. */
export const NATIVE_STATUS_CATEGORIES: readonly NativeStatusCategory[] = Object.freeze([
  "agent",
  "input",
  "tasks",
  "shells",
  "activity",
]);

export type NativeStatusCategory = "agent" | "input" | "tasks" | "shells" | "activity";

/**
 * A category's applicability, as stated by the observer that owns the row.
 * `unsupported` is a POSITIVE statement that this backend/observer cannot report
 * the category; `supported` is the same honesty stated the other way. Absence of a
 * declaration is neither: it is legacy unknown, never not-applicable.
 */
export type NativeStatusSupport = "supported" | "unsupported";

/** Per-category applicability. A category may be omitted; nothing else may appear. */
export type NativeStatusSupportMap = {
  readonly [category in NativeStatusCategory]?: NativeStatusSupport;
};

/** What one category renders as when the observer positively cannot report it. */
export const NATIVE_STATUS_NOT_APPLICABLE_TEXT = "N/A";

export function isNativeStatusCategory(value: unknown): value is NativeStatusCategory {
  return value === "agent"
    || value === "input"
    || value === "tasks"
    || value === "shells"
    || value === "activity";
}

export function isNativeStatusSupport(value: unknown): value is NativeStatusSupport {
  return value === "supported" || value === "unsupported";
}

/** Decoder rows and declarations accept only plain or null-prototype records. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads only own data properties, so an inherited declaration is never a fact. */
function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export type NativeStatusSupportRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid" }
  | { readonly status: "declared"; readonly support: NativeStatusSupportMap };

/**
 * Reads one applicability declaration.
 *
 * Only ABSENCE (`undefined`) is an honest "no declaration". A `null`, a
 * non-record, an array, a non-plain object, an unknown key, or a value outside the
 * closed two-state set is `invalid`: it is never laundered into absence, because a
 * caller that dropped a foreign declaration first would hide exactly the schema
 * widening its peer needs to notice. A well-formed declaration comes back frozen,
 * so a shared map cannot be mutated after it is published.
 */
export function readNativeStatusSupport(value: unknown): NativeStatusSupportRead {
  if (value === undefined) return { status: "absent" };
  if (!isPlainRecord(value)) return { status: "invalid" };
  const record = value;
  const support: { -readonly [K in NativeStatusCategory]?: NativeStatusSupport } = {};
  for (const key of Object.keys(record)) {
    if (!isNativeStatusCategory(key)) return { status: "invalid" };
    const declared = ownField(record, key);
    if (!isNativeStatusSupport(declared)) return { status: "invalid" };
    support[key] = declared;
  }
  return { status: "declared", support: Object.freeze(support) };
}

/**
 * True only for a POSITIVE `unsupported` declaration. An absent map, an absent
 * category, and `supported` all answer `false`, which is what keeps every legacy
 * row (and every Pi row) on its unchanged unknown path.
 */
export function isNativeCategoryUnsupported(
  support: NativeStatusSupportMap | undefined | null,
  category: NativeStatusCategory,
): boolean {
  return support?.[category] === "unsupported";
}

/**
 * Merge one incoming declaration over the current one. Only categories the
 * incoming map actually names change; an undeclared category keeps whatever the
 * row already proved, and no declaration at all never erases an existing one. The
 * result is frozen, or `undefined` when nothing has ever been declared.
 */
export function mergeNativeStatusSupport(
  current: NativeStatusSupportMap | undefined,
  incoming: NativeStatusSupportMap | undefined,
): NativeStatusSupportMap | undefined {
  if (incoming === undefined) return current;
  const read = readNativeStatusSupport(incoming);
  if (read.status !== "declared") return current;
  const merged: { -readonly [K in NativeStatusCategory]?: NativeStatusSupport } = { ...current };
  for (const category of NATIVE_STATUS_CATEGORIES) {
    const declared = read.support[category];
    if (declared !== undefined) merged[category] = declared;
  }
  return Object.freeze(merged);
}

/**
 * One host-observed native status submission. The value fields mirror the existing
 * status-update shape and its honesty rules (absent or `null` is unknown, never
 * `false` or `0`), and `support` carries the observer's own applicability
 * declaration.
 *
 * There is deliberately NO ownership count here (`backgroundTasks` /
 * `backgroundShells`): those belong to this host's own execution, review, and
 * background-shell sources, and a provider harness number must never enter the
 * conservative stop/idle channel. There is also no native conversation tuple and no
 * `inputSurface`: a hosted provider row reports neither a Pi native conversation
 * nor a Pi modal input surface.
 */
export interface NativeStatusObservation {
  /** Observed agent state: true working, false at a positively observed turn end, absent/null unknown. */
  readonly busy?: boolean | null;
  /** Observed pending input: a real pending native question. Absent or null means unknown. */
  readonly pendingInput?: boolean | null;
  /** Observed current/last activity lines; bounded and sanitized by the existing sink. */
  readonly activity?: readonly string[];
  /** Observed count of THIS provider harness's active background subtasks. Absent or null means unknown. */
  readonly activeTasks?: number | null;
  /** Observed count of THIS provider harness's running background shell jobs. Absent or null means unknown. */
  readonly activeShells?: number | null;
  /** The observer's own per-category applicability declaration. */
  readonly support?: NativeStatusSupportMap;
}

/**
 * One observation after validation, with every value category resolved. Like the
 * existing status-update normalization, an observation is a COMPLETE snapshot of
 * what the observer knows right now: a value field it omits is an unknown, never a
 * reason to keep a stale value from an earlier one.
 */
export interface NativeStatusSnapshot {
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly activity: readonly string[];
  readonly activeTasks: number | null;
  readonly activeShells: number | null;
  /** The observation's own declaration, when it carried one. */
  readonly support?: NativeStatusSupportMap;
}

/** The fields one observation may carry, so a rejection can name the field. */
export type NativeStatusObservationField =
  | "record"
  | "busy"
  | "pendingInput"
  | "activity"
  | "activeTasks"
  | "activeShells"
  | "support";

export type NativeStatusObservationRead =
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly field: NativeStatusObservationField }
  | { readonly status: "valid"; readonly snapshot: NativeStatusSnapshot };

/** Nonnegative safe integer, `null` for unknown, `undefined` for malformed. */
function readObservedCount(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value === 0 ? 0 : value; // normalize -0
}

/** Boolean, `null` for unknown, `undefined` for malformed. */
function readObservedBoolean(value: unknown): boolean | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") return undefined;
  return value;
}

/**
 * Strictly reads one observation submitted through a native run's own seam.
 *
 * Unknown keys are rejected, so an ownership count, a conversation tuple, or any
 * other foreign field cannot ride along on a native status submission. Every
 * present field is type-checked: a wrongly typed value REJECTS the observation
 * rather than collapsing silently to unknown, because "the observer sent something
 * broken" and "the observer reports nothing" are different facts. A non-null value
 * for a category the row's current declaration (or this observation's own) says is
 * `unsupported` is NOT a value: the declaration is authoritative, so that category
 * is normalized to unknown while the rest of the snapshot still applies. A
 * declaration can therefore never be contradicted into a number, and one stray field
 * can never freeze the whole row on a stale observation.
 */
export function readNativeStatusObservation(
  value: unknown,
  currentSupport?: NativeStatusSupportMap,
): NativeStatusObservationRead {
  if (value === undefined) return { status: "absent" };
  if (!isPlainRecord(value)) return { status: "invalid", field: "record" };
  const record = value;
  for (const key of Object.keys(record)) {
    if (key !== "busy" && key !== "pendingInput" && key !== "activity"
      && key !== "activeTasks" && key !== "activeShells" && key !== "support") {
      return { status: "invalid", field: "record" };
    }
  }
  const supportRead = readNativeStatusSupport(ownField(record, "support"));
  if (supportRead.status === "invalid") return { status: "invalid", field: "support" };
  const support = supportRead.status === "declared" ? supportRead.support : undefined;
  const effective = mergeNativeStatusSupport(currentSupport, support);

  const busy = readObservedBoolean(ownField(record, "busy"));
  if (busy === undefined) return { status: "invalid", field: "busy" };
  const pendingInput = readObservedBoolean(ownField(record, "pendingInput"));
  if (pendingInput === undefined) return { status: "invalid", field: "pendingInput" };
  const activity = ownField(record, "activity");
  if (activity !== undefined && activity !== null
    && (!Array.isArray(activity) || activity.some((line) => typeof line !== "string"))) {
    return { status: "invalid", field: "activity" };
  }
  const activeTasks = readObservedCount(ownField(record, "activeTasks"));
  if (activeTasks === undefined) return { status: "invalid", field: "activeTasks" };
  const activeShells = readObservedCount(ownField(record, "activeShells"));
  if (activeShells === undefined) return { status: "invalid", field: "activeShells" };

  // A value for a category declared unsupported is not a value: the declaration is
  // authoritative, so that one category stays unknown (and renders not-applicable)
  // while the rest of the snapshot still lands. Absence and `null` were already
  // unknown. This is the only place a submitted value is ever discarded, and it can
  // never produce a zero, an idle reading, or a stale hold-over.
  const observedTasks = isNativeCategoryUnsupported(effective, "tasks") ? null : activeTasks;
  const observedShells = isNativeCategoryUnsupported(effective, "shells") ? null : activeShells;
  const observedBusy = isNativeCategoryUnsupported(effective, "agent") ? null : busy;
  const observedPendingInput = isNativeCategoryUnsupported(effective, "input") ? null : pendingInput;
  const observedActivity = activity === undefined || activity === null
    ? []
    : isNativeCategoryUnsupported(effective, "activity") ? [] : activity as readonly string[];

  const snapshot: {
    busy: boolean | null;
    pendingInput: boolean | null;
    activity: readonly string[];
    activeTasks: number | null;
    activeShells: number | null;
    support?: NativeStatusSupportMap;
  } = {
    busy: observedBusy,
    pendingInput: observedPendingInput,
    activity: observedActivity,
    activeTasks: observedTasks,
    activeShells: observedShells,
  };
  if (support !== undefined) snapshot.support = support;
  return { status: "valid", snapshot };
}

/** Why one native status submit or invalidate did nothing. */
export type NativeStatusRejectCode =
  /** This seam's row, child run, or ownership is no longer current: nothing is queued. */
  | "no-live-run"
  /**
   * This capture belongs to a retired observer generation: the row's observer already
   * reported this capture's failure, so a late callback from that generation cannot
   * write anything, fresh or stale. Recovery acquires a NEW capture from the manager;
   * the row itself may still be live.
   */
  | "retired-capture"
  /** The submitted observation was malformed; the row's current facts are untouched. */
  | "malformed-observation";

export type NativeStatusSubmitResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly code: NativeStatusRejectCode };

const NATIVE_STATUS_ACCEPTED: NativeStatusSubmitResult = Object.freeze({ accepted: true });

/** The one shared accepted answer. */
export function nativeStatusAccepted(): NativeStatusSubmitResult {
  return NATIVE_STATUS_ACCEPTED;
}

/** The one shared rejected answer. */
export function nativeStatusRejected(code: NativeStatusRejectCode): NativeStatusSubmitResult {
  return Object.freeze({ accepted: false, code });
}
