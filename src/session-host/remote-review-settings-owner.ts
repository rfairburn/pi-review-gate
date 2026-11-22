/**
 * The OWNER side of remote Review settings (issue #716).
 *
 * This module is the one composition root that turns the owner's already-fresh
 * on-disk review-gate configuration into the closed load/save exchange the
 * authenticated roster lane carries, and it is the ONLY place that holds the
 * owner's private state for it:
 *
 * - A **load** re-reads the owner's config through
 *   {@link loadOwnedReviewSettings} (no UI, no write), projects it with
 *   {@link projectRemoteReviewSettingsOpening}, and answers with one bounded
 *   envelope carrying an unguessable opening token, the projected opening, the
 *   owner's own model/tool catalogs, the first-use flag, and closed notice
 *   CODES. No config path, working directory, environment, worker argv/env,
 *   raw load diagnostic, or baseline is ever part of it.
 * - A **save** accepts exactly `{ openingId, intent }`. The intent is
 *   decoded by {@link decodeRemoteReviewSettingsSaveIntent} against the
 *   OWNER-retained opening config, so every owner baseline (external-worker
 *   definitions, reference baselines, staged-from task ids, hidden env, the
 *   config path, cwd, and the Pi/tool inventories) comes from this process and
 *   never from the requester. The decoded selection is then committed through
 *   {@link localPersistedSaveBackend.saveStaged}, and the caller learns
 *   `accepted` only from that shared backend's own `saved` result.
 *
 * The retained opening is bounded, process-local, and never persisted. Each
 * authenticated peer key id has ONE opening bound to its exact owner run; a new
 * load for that peer replaces the previous token (whatever run it bound), and
 * the total is capped (the oldest entry is evicted, which only makes its token
 * `stale`). A new authenticated connection for the same peer and owner run can
 * use the opening if it is still current. A successful save retires exactly
 * that token, so replaying an already-confirmed save can never be applied
 * twice. A refused or invalid save keeps the opening for a retry. There is no
 * timer, no automatic retry, and no reconnection handling here.
 *
 * One opening is also single-use at a time: a save CLAIMS its opening
 * synchronously before it awaits anything, so a second authenticated binding
 * presenting the same token is refused as `busy` instead of entering the
 * shared backend. The guard handed to that backend re-reads live authorization
 * AND proves the claimed opening is still the current one, so a save that loses
 * its opening to a newer load or to bounded-memory eviction can never publish
 * after the fact. A first-use initializer that already ran is tracked too: it
 * can publish the destination before a later guard or validation step refuses,
 * so every non-success outcome after it is reported as `unknown`, never as a
 * definite no-write refusal.
 *
 * Refusals are closed codes only: `invalid-draft` for a malformed intent or a
 * shared save-time validation failure, `conflict` ONLY when the shared backend
 * reports one of its fixed pre-write external-worker guard messages,
 * `stale` for a missing/unknown/replaced token, `busy` while another save
 * already holds that exact opening, `policy` for a live authorization refusal,
 * and `unknown` for anything this owner cannot truthfully classify (including a
 * shared failure whose message is not a fixed guard, so a possible post-rename
 * error is never reported as a definite no-write). Raw exception text, paths,
 * and diagnostics never leave this module.
 *
 * A positively confirmed save also carries one bounded receipt of exactly the
 * scheduled tasks the SHARED save-time rule auto-disabled (its stable ids in
 * catalogue order, plus an exact remainder count when more than the receipt's
 * bounded list were disabled). A task the requester disabled itself is never
 * part of it, and a save that is refused, refused after publication, or
 * unclassifiable carries no receipt at all.
 */
import { randomBytes } from "node:crypto";
import type { ReviewGateConfig } from "../config";
import { findOccupiedHostBindings, type HostKeybindingCheck } from "../host-keybindings";
import { isRecord } from "../record-guard";
import type { ScopedModelChoice } from "../settings/models";
import { ConfigWriteNotAuthorizedError } from "../settings/persistence";
import { localPersistedSaveBackend, type PersistedSaveBackend, type PersistedSaveResult } from "../settings/persisted-save";
import { readToolChoices } from "../settings/tools";
import {
  buildReviewSettingsSaveReceipt,
  isReviewSettingsJsonPayload,
  type OwnerReviewSettingsFacts,
  type OwnerReviewSettingsGuard,
  type OwnerReviewSettingsHandler,
  type OwnerReviewSettingsRequest,
  type ReviewSettingsRefusalReason,
} from "./network/peer-review-settings";
import {
  decodeRemoteReviewSettingsSaveIntent,
  projectRemoteReviewSettingsOpening,
  type RemoteReviewSettingsOpening,
  type RemoteReviewSettingsSaveIntent,
} from "./remote-review-settings-data";
import {
  loadOwnedReviewSettings,
  type LocalReviewSettingsDependencies,
  type OwnedReviewSettingsInput,
} from "./review-settings";

/** Entropy of one opening token: 32 random bytes, hex encoded. */
export const REMOTE_REVIEW_SETTINGS_OPENING_ID_BYTES = 32;

/**
 * Hard cap on retained owner openings. The memory is one entry per authenticated
 * peer key id, bound to the opening's run; evicting the oldest entry only makes
 * its token stale, so a bounded owner never publishes the wrong draft.
 */
export const REMOTE_REVIEW_SETTINGS_MAX_OPENINGS = 8;

/**
 * The closed notice codes a load may publish. They describe the RANK of an
 * opening problem (exactly the order the local menu notifies them in) and never
 * carry a message, a path, or a diagnostic.
 */
export type RemoteReviewSettingsNoticeCode =
  | "catalog-warning"
  | "config-warning"
  | "tool-protection-invalid";

export const REMOTE_REVIEW_SETTINGS_NOTICE_CODES: readonly RemoteReviewSettingsNoticeCode[] = Object.freeze([
  "catalog-warning",
  "config-warning",
  "tool-protection-invalid",
]);

/** One tool candidate as published to the requester (configuration names only). */
export interface RemoteReviewSettingsToolChoice {
  name: string;
  description?: string;
}

/**
 * The ONE load envelope (fixed shape): the unguessable opening token, the
 * projected opening, the owner's model and tool catalogs, the first-use flag,
 * and closed notice codes. It is the complete requester-visible opening.
 */
export interface RemoteReviewSettingsLoadEnvelope {
  openingId: string;
  opening: RemoteReviewSettingsOpening;
  scoped: ScopedModelChoice[];
  tools: RemoteReviewSettingsToolChoice[];
  firstUse: boolean;
  notices: RemoteReviewSettingsNoticeCode[];
}

/**
 * The ONE save envelope (fixed shape): the token from the load plus the closed
 * editable intent. There is deliberately no path, cwd, baseline, provenance,
 * model/tool inventory, or function field. This is the typed OUTBOUND shape.
 */
export interface RemoteReviewSettingsSaveEnvelope {
  openingId: string;
  intent: RemoteReviewSettingsSaveIntent;
}

/**
 * The structural, NOT-yet-decoded input shape of one inbound save envelope: the
 * same two exact fields, with `intent` still untrusted. Validating these fields
 * says nothing about the intent's own required fields; that is
 * {@link decodeRemoteReviewSettingsSaveIntent}'s job.
 */
export interface RemoteReviewSettingsSaveEnvelopeInput {
  openingId: string;
  intent: unknown;
}

/** Hermetic seams for the owner composition. */
export interface OwnerReviewSettingsServiceDependencies extends LocalReviewSettingsDependencies {
  /** The shared disk-only Save backend; the real one writes this owner's file. */
  readonly backend?: PersistedSaveBackend;
  /** Unguessable opening-token source (tests inject deterministic tokens). */
  readonly createOpeningId?: () => string;
  /** Trusted owner host-key occupancy predicate for a changed mode shortcut. */
  readonly hostKeyOccupancy?: (shortcut: string) => HostKeybindingCheck;
}

/** One retained owner opening. Closure-private: never persisted or serialized. */
interface RetainedOpening {
  readonly openingId: string;
  readonly peerKeyId: string;
  readonly hostRunId: string;
  readonly config: ReviewGateConfig;
  readonly configPath: string;
  readonly cwd: string;
  readonly scoped: ScopedModelChoice[];
  readonly tools: readonly RemoteReviewSettingsToolChoice[];
  readonly beforePersist?: () => void | Promise<void>;
  /**
   * Exactly one save may hold this opening at a time. It is claimed
   * synchronously before the first await, so two authenticated bindings that
   * present the same token cannot both enter the shared backend.
   */
  claimed: boolean;
}

/**
 * Build the owner's ONE remote Review-settings provider for one session host.
 *
 * The returned handler is transport-shaped (`OwnerReviewSettingsHandler`): it
 * is given only the operation, the exact run, the authenticated peer, and (for
 * a save) the exact payload bytes, plus the bridge's reusable live guard. It
 * opens/commits nothing itself beyond the shared owner services named in the
 * module comment.
 */
export function createOwnerReviewSettingsHandler(
  input: OwnedReviewSettingsInput,
  dependencies: OwnerReviewSettingsServiceDependencies = {},
): OwnerReviewSettingsHandler {
  const backend = dependencies.backend ?? localPersistedSaveBackend;
  const createOpeningId = dependencies.createOpeningId
    ?? (() => randomBytes(REMOTE_REVIEW_SETTINGS_OPENING_ID_BYTES).toString("hex"));
  const hostKeyOccupancy = dependencies.hostKeyOccupancy ?? findOccupiedHostBindings;
  const loadDependencies: LocalReviewSettingsDependencies = dependencies.loadChoices === undefined
    ? {}
    : { loadChoices: dependencies.loadChoices };
  // Bounded owner-only lifetime memory. Insertion order is the eviction order.
  const openings = new Map<string, RetainedOpening>();

  const refused = (reason: ReviewSettingsRefusalReason): OwnerReviewSettingsFacts =>
    ({ kind: "refused", reason });

  function retain(opening: RetainedOpening): void {
    const key = opening.peerKeyId;
    openings.delete(key);
    openings.set(key, opening);
    while (openings.size > REMOTE_REVIEW_SETTINGS_MAX_OPENINGS) {
      const oldest = openings.keys().next();
      if (oldest.done === true) break;
      openings.delete(oldest.value);
    }
  }

  function retire(opening: RetainedOpening): void {
    const key = opening.peerKeyId;
    if (openings.get(key) === opening) openings.delete(key);
  }

  async function load(
    peerKeyId: string,
    hostRunId: string,
    stillAuthorized: OwnerReviewSettingsGuard,
  ): Promise<OwnerReviewSettingsFacts> {
    // Admission: a request the bridge already admitted is still rechecked here,
    // because the owner's own resources are about to be read.
    if (!isStillAuthorized(stillAuthorized)) return refused("policy");
    let loaded: Awaited<ReturnType<typeof loadOwnedReviewSettings>>;
    try {
      // A fresh disk load per open: nothing is cached between opens, no file is
      // created, and no live session config is consulted.
      loaded = await loadOwnedReviewSettings(input, loadDependencies);
    } catch {
      // A catalog/host failure has no positive result to report.
      return { kind: "unknown" };
    }
    if (!isStillAuthorized(stillAuthorized)) return refused("policy");
    if (loaded.kind !== "opened") {
      // A globally disabled gate or an explicitly selected missing config. The
      // local message names the resolved path and is deliberately not sent.
      return refused("unavailable");
    }
    // The owner's catalog is trusted owner state: publish the loader-inclusive
    // inventory (the audit picker's view) and let each picker apply its own
    // canonical read. A description is not needed to edit permissions: SDK
    // definitions can build it from their owner-local cwd, so send names only.
    const tools: RemoteReviewSettingsToolChoice[] = readToolChoices(
      () => loaded.catalog.tools,
      { includeReservedDiscoveryLoader: true },
    ).map(({ name }) => ({ name }));
    const scoped = structuredClone(loaded.catalog.scoped);
    const envelope: RemoteReviewSettingsLoadEnvelope = {
      openingId: createOpeningId(),
      opening: projectRemoteReviewSettingsOpening(loaded.config),
      scoped,
      tools,
      firstUse: loaded.beforePersist !== undefined,
      notices: noticeCodes(
        loaded.catalog.warnings.length > 0,
        loaded.warnings.length > 0,
        loaded.toolProtectionError !== undefined,
      ),
    };
    const payload = encodeEnvelope(envelope);
    if (payload === null) return refused("limit");
    // Before retention: a revoked destination must not become usable state.
    if (!isStillAuthorized(stillAuthorized)) return refused("policy");
    retain({
      openingId: envelope.openingId,
      peerKeyId,
      hostRunId,
      config: loaded.config,
      configPath: loaded.configPath,
      cwd: input.cwd,
      scoped,
      tools,
      claimed: false,
      ...(loaded.beforePersist === undefined ? {} : { beforePersist: loaded.beforePersist }),
    });
    return { kind: "accepted", payload };
  }

  async function save(
    peerKeyId: string,
    hostRunId: string,
    payload: Uint8Array | undefined,
    stillAuthorized: OwnerReviewSettingsGuard,
  ): Promise<OwnerReviewSettingsFacts> {
    if (!isStillAuthorized(stillAuthorized)) return refused("policy");
    const envelope = readSaveEnvelope(payload);
    if (envelope === null) return refused("invalid-draft");
    const key = peerKeyId;
    const retained = openings.get(key);
    if (retained === undefined
      || retained.hostRunId !== hostRunId
      || retained.openingId !== envelope.openingId) {
      // Missing, replaced (possibly for another run of this peer), evicted,
      // retired, or another peer's token. The owner never confirms which.
      return refused("stale");
    }
    if (retained.claimed) {
      // Another save already holds this exact opening (the bridge serializes
      // requests per binding, not across bindings). Only one may enter the
      // shared backend, so a duplicate cannot publish after the first.
      return refused("busy");
    }
    // Claim synchronously, before any await: from here on no other request can
    // enter the backend with this opening.
    retained.claimed = true;
    const release = (): void => {
      retained.claimed = false;
    };
    // The opening must still be THIS map entry at every publication point. A
    // load that replaces it, or a bounded-memory eviction, revokes the claim
    // instead of letting a stale draft publish.
    const isCurrentOpening = (): boolean => openings.get(key) === retained;
    let decoded: ReturnType<typeof decodeRemoteReviewSettingsSaveIntent>;
    try {
      // Every owner-held baseline comes from the retained opening, never from
      // the intent. `scoped` and the tool names are this owner's own catalogs.
      decoded = decodeRemoteReviewSettingsSaveIntent(
        envelope.intent,
        retained.config,
        retained.scoped,
        offeredToolNames(retained.tools),
        hostKeyOccupancy,
      );
    } catch {
      // A malformed/forged intent or a value the owner editor cannot offer. The
      // opening stays current so the requester can correct and retry.
      release();
      return refused("invalid-draft");
    }
    if (!isStillAuthorized(stillAuthorized)) {
      release();
      return refused("policy");
    }
    // The guard the shared backend re-reads at every checkpoint: live
    // authorization AND this exact claimed opening still being current.
    const claimedStillAuthorized = () => isStillAuthorized(stillAuthorized) && isCurrentOpening();
    // Did the owner's first-use initializer run? It can publish the default
    // config before the shared write's own final checks, so a later refusal is
    // not proof that the destination is unchanged.
    let initializerRan = false;
    let result: PersistedSaveResult;
    try {
      // The shared persisted-save backend owns validation, the strict on-disk
      // merge, the first-use initializer, and the guarded atomic write. The
      // reusable guard is handed to it (and re-read at each of its checkpoints),
      // and no requester-supplied path, cwd, provenance, or baseline is used.
      result = await backend.saveStaged({
        configPath: retained.configPath,
        cwd: retained.cwd,
        config: retained.config,
        draftConfig: decoded.draftConfig,
        scoped: retained.scoped,
        selection: decoded.selection,
        scheduledImageProvenance: new Map(),
        stillAuthorized: claimedStillAuthorized,
        ...(retained.beforePersist === undefined ? {} : {
          beforePersist: () => {
            // Recorded BEFORE the call: the initializer can publish a file and
            // still throw, and that publication is a destination change.
            initializerRan = true;
            return retained.beforePersist!();
          },
        }),
      });
    } catch (error) {
      release();
      // Never claim a definite no-write from a lost cache entry or an
      // unclassified rejection: neither proves the destination is unchanged.
      // The same is true once the first-use initializer has run, because it can
      // publish the default config before a later guard refuses.
      if (initializerRan || !(error instanceof ConfigWriteNotAuthorizedError)) return { kind: "unknown" };
      // A typed guard refusal before initialization performed no destination
      // work: the token is stale if this opening is no longer current.
      return refused(isCurrentOpening() ? "policy" : "stale");
    }
    if (result.kind === "saved") {
      // Retire exactly this token: replaying the confirmed save cannot apply it
      // a second time, and a later load issues a new one.
      retire(retained);
      if (!isStillAuthorized(stillAuthorized)) return { kind: "unknown" };
      // Positive confirmation carries exactly what the shared disable rule
      // auto-disabled during THIS save: bounded stable identities only, never a
      // message, task name, worker id, path, or diagnostic. A manual disable is
      // never part of it, and nothing was disabled means no receipt at all.
      const receipt = buildReviewSettingsSaveReceipt(result.scheduleDisableTaskIds);
      return receipt === undefined ? { kind: "accepted" } : { kind: "accepted", receipt };
    }
    // A refused or unclassified result keeps the opening current for a retry.
    release();
    // A first-use initializer may already have published the destination, so no
    // later non-success result is a definite no-write.
    if (initializerRan) return { kind: "unknown" };
    if (result.kind === "invalid") return refused("invalid-draft");
    // A shared conflict result also covers a possible post-rename fault, so only
    // a fixed external-worker guard message is a definite no-write.
    return isFixedExternalWorkerConflict(result.error) ? refused("conflict") : { kind: "unknown" };
  }

  return async function handleOwnerReviewSettings(
    request: OwnerReviewSettingsRequest,
    stillAuthorized: OwnerReviewSettingsGuard,
  ): Promise<OwnerReviewSettingsFacts> {
    const peerKeyId = request.peerKey?.keyId;
    const hostRunId = request.hostRunId;
    if (typeof peerKeyId !== "string" || peerKeyId.length === 0
      || typeof hostRunId !== "string" || hostRunId.length === 0) {
      return { kind: "unknown" };
    }
    if (request.kind === "load") return load(peerKeyId, hostRunId, stillAuthorized);
    if (request.kind === "save") return save(peerKeyId, hostRunId, request.payload, stillAuthorized);
    return { kind: "unknown" };
  };
}

/** The bridge's reusable live proof. False, a throw, or an absent guard refuses. */
function isStillAuthorized(stillAuthorized: OwnerReviewSettingsGuard | undefined): boolean {
  if (typeof stillAuthorized !== "function") return false;
  try {
    return stillAuthorized() === true;
  } catch {
    return false;
  }
}

/**
 * One bounded UTF-8 JSON payload, or null. Reusing the transport's own
 * validator guarantees the bridge will accept exactly what this owner sends
 * (and refuses anything over its explicit ceiling instead of truncating).
 */
function encodeEnvelope(value: unknown): Uint8Array | null {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  const bytes = new TextEncoder().encode(text);
  return isReviewSettingsJsonPayload(bytes) ? bytes : null;
}

/**
 * Closed-shape validation of one inbound save envelope. The bridge has already
 * proved the bytes are bounded UTF-8 JSON; here only the two fixed fields are
 * accepted. `intent` is deliberately opaque: this predicate must not claim the
 * intent has any required field, because the owner decode validates it.
 */
export function isRemoteReviewSettingsSaveEnvelope(value: unknown): value is RemoteReviewSettingsSaveEnvelopeInput {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2
    && keys.includes("openingId")
    && keys.includes("intent")
    && typeof value.openingId === "string"
    && value.openingId.length > 0;
}

function readSaveEnvelope(payload: Uint8Array | undefined): RemoteReviewSettingsSaveEnvelopeInput | null {
  if (!(payload instanceof Uint8Array) || !isReviewSettingsJsonPayload(payload)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    return null;
  }
  return isRemoteReviewSettingsSaveEnvelope(parsed) ? parsed : null;
}

/**
 * This owner's offered tool names, read through the canonical candidate reader:
 * the deny pickers never offer the reserved discovery loader, while the audit
 * picker keeps it. The published inventory already contains it when the owner
 * has it, so both reads come from the same trusted list.
 */
function offeredToolNames(tools: readonly RemoteReviewSettingsToolChoice[]): {
  deny: readonly string[];
  audit: readonly string[];
} {
  const provider = () => tools;
  return {
    deny: readToolChoices(provider).map((choice) => choice.name),
    audit: readToolChoices(provider, { includeReservedDiscoveryLoader: true }).map((choice) => choice.name),
  };
}

/** Closed notice codes in the local menu's consequence order, never a message. */
function noticeCodes(catalogWarning: boolean, configWarning: boolean, toolProtectionInvalid: boolean): RemoteReviewSettingsNoticeCode[] {
  const codes: RemoteReviewSettingsNoticeCode[] = [];
  if (catalogWarning) codes.push("catalog-warning");
  if (configWarning) codes.push("config-warning");
  if (toolProtectionInvalid) codes.push("tool-protection-invalid");
  return codes;
}

/**
 * The shared commit's fixed pre-write external-worker guard messages. They are
 * thrown by `persistReviewSettings` while reading/merging/validating the latest
 * on-disk document, i.e. strictly BEFORE the atomic rename, so a conflict
 * result carrying one of them is a definite non-publication. Every other
 * rejection stays `unknown`: the same result kind also covers a fault that may
 * have occurred after the rename.
 *
 * Keep this list in sync with src/settings/persistence.ts and
 * src/settings/external-agent-catalog.ts; anything unmatched is unknown.
 */
const FIXED_EXTERNAL_WORKER_CONFLICT_MESSAGES: readonly string[] = Object.freeze([
  "External worker settings changed or are invalid on disk. Reopen settings before saving.",
  "External worker draft IDs collide. Reopen settings before saving.",
  "An edited external worker changed or disappeared on disk. Reopen settings before saving.",
  "Missing external worker opening baseline. Reopen settings.",
  "An external worker ID created in this menu already exists on disk. Reopen settings.",
  "An external worker ID created in this menu already exists on disk. Reopen settings and create it with a different ID.",
  "External worker rename destination already exists on disk. Reopen settings and choose a different ID.",
  "External worker references changed on disk. Reopen settings to review the rename/deletion cascade before saving.",
  "A selected external reviewer no longer supports review on disk. Reopen settings and select an available reviewer.",
  "A selected external worker no longer supports execution on disk. Reopen settings and select an available worker.",
  "A selected research worker is no longer research-capable on disk. Reopen settings and select a research-capable worker.",
  "A scheduled research worker is no longer research-capable on disk. Reopen settings and select a research-capable worker.",
  "A preserved schedule still pins a removed worker resource. Reopen settings before saving.",
]);

/** The shared conflict notice prefix, exactly as `commitPersistedSave` composes it. */
const SHARED_CONFLICT_PREFIX = "Cannot save external worker changes: ";

/** True only for one exact fixed shared guard message after the fixed prefix. */
function isFixedExternalWorkerConflict(error: string): boolean {
  if (typeof error !== "string" || !error.startsWith(SHARED_CONFLICT_PREFIX)) return false;
  return FIXED_EXTERNAL_WORKER_CONFLICT_MESSAGES.includes(error.slice(SHARED_CONFLICT_PREFIX.length));
}
