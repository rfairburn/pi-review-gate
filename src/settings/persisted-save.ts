/**
 * The non-UI disk-only Review-settings Save boundary (issue #716).
 *
 * The shared /review-settings menu stages ONE canonical selection in memory: a
 * `ReviewSettingsSelection` over its draft config, staged catalogs, and
 * external-worker operation log. This module owns what a disk-only Save does
 * to that staged payload, so a second host can invoke the identical rules on
 * the OWNER of a config without a UI and without a second copy of them:
 *
 * - {@link preparePersistedSave} — workspace expansion, the save-time
 *   validation (worker resources, reviewer layers, routes, scheduled tasks,
 *   tool protection), the unservable-pin disable rule, and the scheduled-image
 *   preparation transaction. It performs no UI calls: every failure is typed
 *   data carrying the exact message the menu notifies.
 * - {@link commitPersistedSave} — the strict on-disk merge and canonical
 *   atomic write through `persistReviewSettings`, the caller-local
 *   `beforePersist` step, and the existing rollback policy for a rejected
 *   write (prepared image copies are reclaimed unless a post-rename failure
 *   may have left the persisted text referencing them).
 *
 * Neither helper adds a rule of its own: they compose the existing validation,
 * merge, provenance, and persistence seams, so the staged-field merge,
 * external-worker optimistic guards, scheduled-entry protections, and image
 * rollback stay in shared code.
 *
 * {@link PersistedSaveBackend} is the narrow seam the shared menu uses for its
 * persisted-only Save. {@link localPersistedSaveBackend} is the default: it
 * composes both halves against this process's config path. A delegating
 * backend receives the same internal staged payload and is responsible for the
 * whole Save on the owner; the menu calls it before any requester-local
 * preparation, so submitting a draft for another host performs no local path
 * probe, managed image copy, directory check, or config read/write.
 *
 * {@link StagedPersistedSave} is INTERNAL menu state, not a wire DTO: it carries
 * live config objects, a process-local provenance map, pre-cascade reference
 * baselines, and one canonical staged selection. A remote protocol introduced
 * later must translate it at that boundary instead of serializing it as-is.
 */
import {
  type ReviewGateConfig,
  type ScheduledTaskCatalog,
} from "../config";
import type { ToolProtectionConfig } from "../tool-protection/config";
import type { ScopedModelChoice } from "./models";
import {
  assertConfigWriteStillAuthorized,
  ConfigWriteNotAuthorizedError,
  persistReviewSettings,
  type ConfigWriteStillAuthorized,
  type ReviewSettingsSelection,
} from "./persistence";
import {
  prepareScheduledImageAssets,
  rollbackScheduledImageAssets,
  rollbackScheduledImageAssetsUnlessPersisted,
  type PreparedScheduledImageAssets,
} from "./scheduled-image-assets";
import {
  disableUnservableScheduledTasks,
  expandScheduledTaskWorkspaces,
  validateScheduledTasks,
} from "./scheduled-tasks";
import {
  collectExternalAgentAvailabilityWarnings,
  validateSelection,
  validateToolProtectionSelection,
  type SettingsValidationPolicy,
} from "./validation";

/**
 * The complete canonical staged selection of one disk-only Save. The shared
 * menu always stages the scheduled catalog and the tool-protection block, so
 * the boundary requires both: preparation derives every validation input from
 * this ONE object, and the backend commits it with only the prepared catalog
 * substituted. No post-preparation callback can carry a different selection
 * into the commit.
 */
export interface PersistedSaveSelection extends ReviewSettingsSelection {
  /** The editable staged catalog; preparation returns the final one. */
  scheduledTasks: ScheduledTaskCatalog;
  /** The staged tool-protection block, validated against core's two hard rules. */
  toolProtection: ToolProtectionConfig;
}

/**
 * The non-UI staged input of one disk-only Save: the one canonical staged
 * selection plus the caller's configs, inventories, and image provenance.
 * Preparation never mutates it; the workspace-expanded catalog is returned
 * instead.
 */
export interface PersistedSavePreparationInput {
  /** The explicit config file the Save targets (the owner's path for a delegating backend). */
  configPath: string;
  /** Session cwd anchoring workspace-relative scheduled-task validation. */
  cwd?: string;
  /** The config the menu staged against; carries the opening already-run/resource baseline. */
  config: ReviewGateConfig;
  /** Menu-local draft config carrying the staged external-agent cascade. */
  draftConfig: ReviewGateConfig;
  /** Scoped model choices the validation treats as available. */
  scoped: ScopedModelChoice[];
  /** The one canonical staged selection this Save validates and commits. */
  selection: PersistedSaveSelection;
  /** Provenance-carrying observed native image inserts, keyed by task id. */
  scheduledImageProvenance: ReadonlyMap<string, readonly string[]>;
  /**
   * Optional synchronous destination-publication guard (issue #716); see
   * {@link ConfigWriteStillAuthorized}. The signature is exactly
   * `() => boolean`: synchronous, no arguments, and re-read fresh at every
   * check. Preparation reads it before workspace expansion, before each
   * scheduled workspace probe, and before the managed-image transaction, so a
   * destination that is no longer eligible performs no new destination-side
   * path work and receives no copies for a Save that cannot be published.
   * Absent for the standard local menu.
   */
  stillAuthorized?: ConfigWriteStillAuthorized;
}

/** A fully prepared Save: the menu may apply or persist this staged result. */
export interface PreparedPersistedSave {
  kind: "prepared";
  /**
   * The workspace-expanded editable catalog. The menu keeps this spelling in
   * its draft even when a later step fails, exactly as before extraction.
   */
  scheduledTasks: ScheduledTaskCatalog;
  /** The final staged catalog: unservable pins disabled, managed image paths substituted. */
  catalogForApply: ScheduledTaskCatalog;
  /** Managed copies positively created by this preparation (the rollback list). */
  prepared?: PreparedScheduledImageAssets;
  /**
   * The validation policy used for this preparation. Its warning collector is
   * cleared and reused for the post-save availability announcement, so a
   * warning from the opening snapshot is never presented as saved-catalog news.
   */
  validationPolicy: SettingsValidationPolicy;
  scheduleDisableWarnings: readonly string[];
  /**
   * Stable identities of exactly the entries the shared rule auto-disabled,
   * in catalogue order. Never a manually disabled entry: this is the structured
   * form of {@link scheduleDisableWarnings} for a non-UI (remote) caller.
   */
  scheduleDisableTaskIds: readonly string[];
  toolProtectionWarnings: readonly string[];
}

/** A preparation that failed its validation or image transaction. */
export interface InvalidPersistedSave {
  kind: "invalid";
  /** The workspace-expanded editable catalog (the draft keeps this spelling). */
  scheduledTasks: ScheduledTaskCatalog;
  /** The exact user-facing failure text the menu notifies. */
  error: string;
}

/** The result of the shared non-UI preparation. */
export type PersistedSavePreparation = PreparedPersistedSave | InvalidPersistedSave;

/**
 * Run the shared save-time preparation for one staged disk-only Save.
 *
 * The order is the menu's existing order: expand `~`/`~/...` workspaces,
 * disable entries this change makes unrunnable, validate both reviewer layers
 * and the scheduled catalog, enforce core's tool-protection rules, then run
 * the managed-image transaction. A validation failure stops before any image
 * copy; an image failure rolls back exactly the copies this call created. No
 * notice is emitted and no config file is read or written here. With an
 * optional destination guard, an unauthorized destination is refused as
 * {@link ConfigWriteNotAuthorizedError} before any workspace expansion, before
 * each scheduled workspace probe, and before the managed-image transaction:
 * it is a refused publication, not an invalid staged draft.
 */
export async function preparePersistedSave(input: PersistedSavePreparationInput): Promise<PersistedSavePreparation> {
  // Issue #716: re-read destination authorization BEFORE any destination-side
  // path work. Workspace expansion resolves a leading `~` against THIS
  // (destination) home, and scheduled-task validation stats each user-selected
  // workspace directory, so an already-refused destination must perform
  // neither — including the case where a missing directory would otherwise
  // produce an invalid-draft result naming the expanded path. The same guard
  // is re-read below, immediately before the managed-image transaction,
  // because authorization can change while validation awaits filesystem
  // operations.
  assertConfigWriteStillAuthorized(input.stillAuthorized);
  // Every validation input comes from the ONE staged selection this Save will
  // commit, so preparation and persistence can never see different fields.
  const selection = input.selection;
  // Expand a leading `~`/`~/...` — entered in the menu or hand-edited into the
  // config file — against the user's home before validation and persistence.
  // This stores an absolute spelling, not a symlink-resolved path. Relative
  // and other spellings keep their parent-session-cwd anchor at run time.
  const scheduledTasks = expandScheduledTaskWorkspaces(selection.scheduledTasks);
  // #465: an entry whose pinned worker this change makes unrunnable is
  // disabled in THIS apply candidate only, so Save persists it, root Escape
  // applies it for the session, and the scheduler never admits it again. A
  // failed attempt leaves the editable draft unchanged; a retry re-evaluates.
  const unservable = disableUnservableScheduledTasks(scheduledTasks, selection.workerResources, input.draftConfig, input.config);
  const warnings = new Set<string>();
  const validationPolicy: SettingsValidationPolicy = { allowMissingApplicationCli: true, warnings };
  const selectionError = (await validateSelection(selection.workerResources, selection.primaryReviewers, input.draftConfig, input.scoped, selection.executeRoute, selection.researchRoute, validationPolicy))
    ?? (await validateSelection(selection.workerResources, selection.subtaskReviewers, input.draftConfig, input.scoped, selection.executeRoute, selection.researchRoute, validationPolicy));
  if (selectionError) return { kind: "invalid", scheduledTasks, error: selectionError };
  const validateCatalog = (catalog: ScheduledTaskCatalog) =>
    validateScheduledTasks(catalog, selection.workerResources, input.draftConfig, input.scoped, input.cwd, validationPolicy);
  let error: string | undefined;
  if (input.stillAuthorized === undefined) {
    // Unguarded local saves keep the exact whole-catalog validation call.
    error = await validateCatalog(unservable.catalog);
  } else {
    // Issue #716: reviewer validation and each workspace probe await, so
    // authorization can be revoked between entries. Validate one entry at a
    // time and re-read the guard immediately before each entry can probe its
    // user-selected workspace path. This does not cancel a probe already in
    // flight; it prevents starting a NEW probe on a destination that is no
    // longer authorized, and refuses as the typed publication error instead
    // of returning an invalid workspace result naming the expanded path.
    for (const [id, entry] of Object.entries(unservable.catalog)) {
      assertConfigWriteStillAuthorized(input.stillAuthorized);
      error = await validateCatalog({ [id]: entry });
      if (error) break;
    }
  }
  if (error) return { kind: "invalid", scheduledTasks, error };
  // #536: core's strict rules (an enabled level needs an auditor; a selected
  // audit scope needs at least one exact name) stop the apply here so the
  // user can fix them, instead of failing later with an unusable block or
  // quietly dropping protection. An auditor that merely does not resolve
  // today is a warning: the unresolved selection is saved as chosen.
  const toolProtectionCheck = validateToolProtectionSelection(selection.toolProtection, input.draftConfig, input.scoped);
  if (toolProtectionCheck.error) return { kind: "invalid", scheduledTasks, error: toolProtectionCheck.error };
  // The Save-time transaction for images pasted through the native host
  // editor (see ./scheduled-image-assets.ts): every observed native insert is
  // verified against the FINAL staged instructions and actual image content,
  // copied into the private managed store, and the staged temporary path is
  // replaced by the managed absolute path BEFORE the config is applied or
  // persisted. Any failure (missing, non-image, too large, or an unobserved Pi
  // clipboard temp reference) fails closed with an actionable notice and
  // leaves the config and the managed store untouched — the menu stays open,
  // so the user can Cancel (which copies nothing) or fix the entry and retry.
  let prepared: PreparedScheduledImageAssets | undefined;
  let catalogForApply = unservable.catalog;
  // Issue #716: re-read destination authorization before the managed-image
  // transaction prepares any destination path or copy. Validation above is
  // read-only, but this step creates directories and files next to the
  // destination config, so a destination that is no longer eligible must be
  // refused before anything is written there. A refusal is thrown as the
  // typed destination refusal, never returned as an invalid staged draft:
  // nothing about the user's selection is invalid, and the caller must report
  // a refused publication rather than ask the user to edit and retry.
  assertConfigWriteStillAuthorized(input.stillAuthorized);
  try {
    prepared = await prepareScheduledImageAssets(input.configPath, catalogForApply, input.scheduledImageProvenance);
    catalogForApply = prepared.catalog;
  } catch (error) {
    return { kind: "invalid", scheduledTasks, error: `review gate: ${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    kind: "prepared",
    scheduledTasks,
    catalogForApply,
    ...(prepared !== undefined ? { prepared } : {}),
    validationPolicy,
    scheduleDisableWarnings: unservable.warnings,
    scheduleDisableTaskIds: unservable.disabledTaskIds,
    toolProtectionWarnings: toolProtectionCheck.warnings,
  };
}

/** The non-UI input of one commit: the fully prepared selection plus its copies. */
export interface PersistedSaveCommitInput {
  /** The explicit config file the strict merge and atomic write target. */
  configPath: string;
  /** The complete canonical staged selection, including the prepared catalog. */
  selection: ReviewSettingsSelection;
  /** Managed copies positively created by this Save's preparation. */
  prepared?: PreparedScheduledImageAssets;
  /**
   * Optional synchronous destination-publication guard (issue #716); see
   * {@link ConfigWriteStillAuthorized}. Read before `beforePersist` and
   * re-read inside the shared persistence boundary after its per-config queue
   * wait and immediately before the publishing rename. A refusal is thrown as
   * {@link ConfigWriteNotAuthorizedError} and never reported as an
   * external-worker conflict, because no merge happened.
   */
  stillAuthorized?: ConfigWriteStillAuthorized;
  /**
   * Optional caller step run only after preparation and immediately before
   * the canonical write. A rejection follows the existing Save failure policy
   * and writes nothing.
   */
  beforePersist?: () => void | Promise<void>;
}

/**
 * The commit outcome. `conflict` is the existing external-worker save policy:
 * the caller kept a transaction with external-worker changes, so the menu
 * stays open with an error notice instead of rejecting out of the run. Any
 * other rejection is rethrown unchanged.
 */
export type PersistedSaveCommit =
  | { kind: "saved"; config: ReviewGateConfig }
  | { kind: "conflict"; error: string };

/**
 * Run the shared non-UI commit for one prepared staged Save: the optional
 * `beforePersist` step, then the strict merge and atomic canonical write.
 *
 * A failed `beforePersist` or write leaves the config untouched (or, if the
 * atomic rename landed before the rejection, keeps exactly the managed copies
 * the persisted text references) and rolls back this Save's managed copies.
 * When this staged payload carries external-worker operations the failure is
 * returned as a menu-preserving conflict with the existing notice text;
 * otherwise it is rethrown exactly as before. A destination guard refusal is
 * the one exception: it is always rethrown as
 * {@link ConfigWriteNotAuthorizedError} (after rolling back this Save's
 * prepared copies), because it is not a merge conflict and no rename was
 * attempted.
 */
export async function commitPersistedSave(input: PersistedSaveCommitInput): Promise<PersistedSaveCommit> {
  const keepMenuOpen = (input.selection.externalAgentOperations?.length ?? 0) > 0;
  const conflictText = (error: unknown): string =>
    `Cannot save external worker changes: ${error instanceof Error ? error.message : "persistence conflict"}`;
  try {
    // Issue #716: re-read destination authorization BEFORE the owner-side
    // first-use initializer. A revoked or disabled destination must not run
    // that synchronous hook, and must not publish a staged payload whose only
    // earlier check was from a stale frame.
    assertConfigWriteStillAuthorized(input.stillAuthorized);
    if (input.beforePersist) await input.beforePersist();
  } catch (error) {
    // Nothing was published: every copy this Save prepared is unreferenced.
    if (input.prepared) await rollbackScheduledImageAssets(input.prepared);
    // A destination refusal keeps its own identity even when the staged
    // payload carries external-worker changes: refusing to publish is not a
    // merge conflict, and the destination must be able to report it as such.
    if (error instanceof ConfigWriteNotAuthorizedError) throw error;
    if (!keepMenuOpen) throw error;
    return { kind: "conflict", error: conflictText(error) };
  }
  try {
    const config = await persistReviewSettings(
      input.configPath,
      input.selection,
      input.stillAuthorized !== undefined ? { stillAuthorized: input.stillAuthorized } : {},
    );
    return { kind: "saved", config };
  } catch (error) {
    if (error instanceof ConfigWriteNotAuthorizedError) {
      // Issue #716: the guard refused after the queue wait or immediately
      // before the rename, so no rename was invoked. This is deliberately
      // NOT the post-rename fault policy below: no publication can reference
      // the copies this Save prepared, so roll back exactly those owned
      // copies (the write boundary has already removed its own staged temp).
      // The refusal is rethrown as itself for the same reason as above.
      if (input.prepared) await rollbackScheduledImageAssets(input.prepared);
      throw error;
    }
    // A failed Save mutates nothing and retains the pending delta — but the
    // atomic config write can reject AFTER its rename already replaced the
    // file, in which case the persisted text references the just-created
    // copies. The rollback reads the config first and keeps any created copy
    // the persisted text references (and everything when the config cannot
    // be read); the staged catalog keeps the original temporary paths so a
    // later Save can retry either way.
    if (input.prepared) await rollbackScheduledImageAssetsUnlessPersisted(input.configPath, input.prepared);
    if (!keepMenuOpen) throw error;
    return { kind: "conflict", error: conflictText(error) };
  }
}

/**
 * The staged menu payload one disk-only Save commits. The selection is plain
 * data captured BEFORE preparation: a backend never trusts a post-preparation
 * callback to carry the validated catalog forward; it substitutes the prepared
 * catalog into this same selection immediately before the commit.
 */
export interface StagedPersistedSave extends PersistedSavePreparationInput {
  /**
   * Optional synchronous destination-publication guard (issue #716); see
   * {@link ConfigWriteStillAuthorized}. Signature: `() => boolean`,
   * synchronous, no arguments, re-read fresh at every checkpoint. The
   * destination that owns the target config supplies it (for example a host
   * accepting remote settings while its opt-in and the requesting peer's
   * connection are live); the standard local sidebar supplies none and keeps
   * its exact behavior. A frame is never authorized by its own earlier state:
   * the guard is checked before workspace expansion, before each scheduled
   * workspace probe, before managed-image preparation, before the initializer
   * hook, after the per-config write queue wait, and immediately before the
   * rename.
   */
  stillAuthorized?: ConfigWriteStillAuthorized;
  /**
   * Optional owner-side step run only on an explicit Save, after preparation
   * and immediately before the canonical write (the session host's first-use
   * guarded initializer). A delegating backend is responsible for running it
   * on the owner, or for declining it because that owner has no such draft.
   */
  beforePersist?: () => void | Promise<void>;
}

/** The disk-only Save outcome the shared menu acts on. */
export type PersistedSaveResult =
  | {
      kind: "saved";
      /** The config actually written (as normalized by the persistence boundary). */
      config: ReviewGateConfig;
      /** The workspace-expanded editable catalog the open menu keeps staging against. */
      scheduledTasks: ScheduledTaskCatalog;
      /** Post-save availability warnings for the saved catalog, already collected. */
      warnings: readonly string[];
      scheduleDisableWarnings: readonly string[];
      /** The same auto-disabled entries as stable task identities (never text). */
      scheduleDisableTaskIds: readonly string[];
      toolProtectionWarnings: readonly string[];
    }
  | { kind: "invalid"; scheduledTasks: ScheduledTaskCatalog; error: string }
  | { kind: "conflict"; scheduledTasks: ScheduledTaskCatalog; error: string };

/**
 * The narrow persisted-only Save seam (issue #716).
 *
 * {@link localPersistedSaveBackend} performs the whole Save in this process.
 * A delegating implementation must treat `saveStaged` as the only entry point
 * and must not require the requester to prepare anything: the menu builds the
 * staged payload in memory and calls this before any local path probe, image
 * copy, directory check, or config access. Its `scheduledTasks` result keeps
 * the owner-side workspace expansion in the open menu draft.
 */
export interface PersistedSaveBackend {
  saveStaged(request: StagedPersistedSave): Promise<PersistedSaveResult>;
}

/**
 * The default persisted-only Save backend: shared preparation, then the shared
 * commit, both against this process's config path. It is the only implementation
 * that touches the local filesystem, and it only runs when a caller supplied no
 * delegating backend.
 */
export const localPersistedSaveBackend: PersistedSaveBackend = {
  async saveStaged(request) {
    const preparation = await preparePersistedSave(request);
    if (preparation.kind === "invalid") {
      return { kind: "invalid", scheduledTasks: preparation.scheduledTasks, error: preparation.error };
    }
    // The prepared catalog is authoritative. Commit the SAME staged selection
    // preparation validated, with only its scheduled catalog replaced by the
    // prepared one (workspace expansion, unservable disable, managed image
    // paths), so no caller-supplied catalog can persist unchecked paths.
    const selection: PersistedSaveSelection = {
      ...request.selection,
      scheduledTasks: preparation.catalogForApply,
    };
    const commit = await commitPersistedSave({
      configPath: request.configPath,
      selection,
      ...(preparation.prepared !== undefined ? { prepared: preparation.prepared } : {}),
      ...(request.stillAuthorized !== undefined ? { stillAuthorized: request.stillAuthorized } : {}),
      ...(request.beforePersist !== undefined ? { beforePersist: request.beforePersist } : {}),
    });
    if (commit.kind === "conflict") {
      return { kind: "conflict", scheduledTasks: preparation.scheduledTasks, error: commit.error };
    }
    // Include inactive definitions and additions preserved from the latest
    // on-disk catalog. Availability probes never launch the application. The
    // saved catalog is announced, not stale draft warnings from the opening
    // snapshot: the validation-time collector is cleared first.
    preparation.validationPolicy.warnings?.clear();
    await collectExternalAgentAvailabilityWarnings(commit.config, preparation.validationPolicy);
    return {
      kind: "saved",
      config: commit.config,
      scheduledTasks: preparation.scheduledTasks,
      warnings: [...(preparation.validationPolicy.warnings ?? [])],
      scheduleDisableWarnings: preparation.scheduleDisableWarnings,
      scheduleDisableTaskIds: preparation.scheduleDisableTaskIds,
      toolProtectionWarnings: preparation.toolProtectionWarnings,
    };
  },
};
