/**
 * The REQUESTER side of remote Review settings (issue #716).
 *
 * This module adapts ONE owner's remote Review-settings load/save exchange to
 * the shared persisted settings menu, without moving the menu or its UI: the
 * menu runs locally against the requester's own {@link UiContext} and only its
 * Save backend is remote. It deliberately knows nothing about sockets,
 * authentication, runs, or payload framing — the caller supplies two narrow,
 * no-argument callbacks that already carry that context:
 *
 * - `load()` returns the owner's closed load result (`loaded` with one bounded
 *   envelope, `refused`, `not-sent`, or `unknown`).
 * - `save(payload)` sends exactly one bounded save envelope and returns the
 *   owner's closed save result.
 *
 * The caller also supplies the captured display `label`, its existing UI, the
 * shared host-target control, and an {@link AbortSignal} that aborts when this
 * pane, target, or connection is no longer current. The signal is the
 * connection/staleness input for this adapter: it closes an open menu without
 * preserving its draft, refuses to send when it is already aborted, and makes
 * an abort during a save an honest `unknown` (bytes may already have left)
 * rather than a fabricated "nothing sent". Every waitable UI call and the
 * caller's target picker are fenced BEFORE invocation, so an abort cannot reach
 * the live pane and a picker result delivered after staleness is never a
 * switch. A disconnected or superseded editor therefore never restores a stale
 * draft on reopen or manual reconnect: every open starts with a fresh owner
 * load.
 *
 * Decoding is strict and closed. The versioned envelope, its projected opening
 * config, and the owner's model/tool picker metadata are shape-checked and
 * bounded before the shared menu is invoked. The projected opening is NOT
 * normalized as one whole config: that would drop the presentation-only legacy
 * reasoning metadata and synthesized native commands onto definitions that
 * carry no command by design. Instead the editable sections are validated by
 * the shared canonical normalizer (with canonical validation stand-ins for the
 * projected external-worker definitions), while the projected definitions
 * themselves are decoded structurally and preserved exactly, including their
 * legacy reasoning presentation and unsupported adapter roles. Nested
 * collections (reviewer selections, worker selections, route entries,
 * scheduled entries and their review overrides) are shape-checked BEFORE
 * normalization, so a missing or unexpected projected field is refused rather
 * than defaulted or dropped. Explicit collection limits plus an aggregate
 * reference-work budget bound the menu's synchronous opening work before it
 * begins. Non-editable projection defaults are never read from the wire; they
 * are replaced with this build's own defaults.
 *
 * A Save requires the owner's own positive acceptance. `invalid-draft` and
 * `conflict` keep the current draft so it can be corrected or reopened; every
 * other owner refusal, every positively-not-sent result, and every unknown
 * outcome ends the editor with a truthful fixed notice. A positively confirmed
 * Save may also carry the owner's bounded receipt of exactly the scheduled
 * tasks its shared save-time rule auto-disabled; each becomes one fixed
 * will-not-run notice through the menu's existing post-save warning path, with
 * the task name read from THIS editor's own staged draft (never from owner
 * text). Nothing is retried,
 * no local config is read or written, and no owner reply is ever displayed
 * raw: notices use fixed text plus the caller's captured label.
 */
import {
  BROWSER_PERMISSION_FIELDS,
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  normalizeConfig,
  type ExternalAgentAdapter,
  type ExternalAgentCatalog,
  type ExternalAgentRoleConfig,
  type ExternalAgentValue,
  type ReviewGateConfig,
  type ScheduledTaskCatalog,
  type ThinkingLevel,
} from "../config";
import {
  isNativeReasoningEffort,
  type NativeReasoningEffort,
  type ReasoningImport,
  type ReasoningImportPresentation,
  type ReasoningWarning,
} from "../external-agent-reasoning";
import { isRecord } from "../record-guard";
import { setCatalogKey } from "../settings/catalog-key";
import { runPersistedReviewSettings, type PersistedReviewSettingsInput } from "../settings/command";
import type { ExternalAgentEffortLevel, GuidedExternalAgentAdapter } from "../settings/external-agent-models";
import type { ScopedModelChoice } from "../settings/models";
import type { PersistedSaveBackend, PersistedSaveResult, StagedPersistedSave } from "../settings/persisted-save";
import { notify, withSettingsSectionHelp, type UiContext } from "../settings/ui";
import { withoutResourceThinkingCatalog } from "../settings/workers";
import {
  isReviewSettingsJsonPayload,
  type PeerReviewSettingsLoadOutcome,
  type PeerReviewSettingsNotSentReason,
  type PeerReviewSettingsResult,
  type PeerReviewSettingsSaveOutcome,
  type ReviewSettingsRefusalReason,
  type ReviewSettingsSaveReceipt,
} from "./network/peer-review-settings";
import {
  REMOTE_REVIEW_SETTINGS_DATA_VERSION,
  RemoteReviewSettingsDataError,
  encodeRemoteReviewSettingsSaveIntent,
  type RemoteReviewSettingsSaveIntent,
} from "./remote-review-settings-data";
import {
  REMOTE_REVIEW_SETTINGS_NOTICE_CODES,
  type RemoteReviewSettingsLoadEnvelope,
  type RemoteReviewSettingsNoticeCode,
  type RemoteReviewSettingsSaveEnvelope,
  type RemoteReviewSettingsToolChoice,
} from "./remote-review-settings-owner";

/**
 * The exact input of one remote editor open. The label is the caller's already
 * captured, sanitized owner display label; it is used only in fixed notice
 * text. The two callbacks carry all run/connection context themselves, and the
 * signal carries whether this pane is still current.
 */
export interface OpenRemoteReviewSettingsInput {
  /** Captured owner display label for fixed notices. Never a path or identity. */
  readonly label: string;
  readonly ui: UiContext;
  /** The shared root-menu host switch, exactly as the Local editor uses it. */
  readonly targetControl?: PersistedReviewSettingsInput["targetControl"];
  /** Aborts when this pane, target, or connection is no longer current. */
  readonly signal?: AbortSignal;
  /** One bounded owner load. Never carries requester-local state. */
  readonly load: () => Promise<PeerReviewSettingsResult<PeerReviewSettingsLoadOutcome>>;
  /** One bounded owner save of exactly this envelope. */
  readonly save: (payload: Uint8Array) => Promise<PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome>>;
  /** Current connection status for a failed Save notice, never send authority. */
  readonly disconnected?: () => boolean;
}

/**
 * Open the shared Review settings menu once for another host. Returns true
 * only for the caller's accepted target switch (Main then loads the newly
 * chosen target); `false` means this editor ended, whether by Save, Cancel,
 * root Escape, a refusal, a disconnect, or an unknown outcome.
 */
export async function openRemoteReviewSettings(input: OpenRemoteReviewSettingsInput): Promise<boolean> {
  const { label, ui, signal } = input;
  // A closed or superseded pane never even requests the owner's settings.
  if (signal?.aborted) return false;
  let finished = false;
  let accepted = false;
  const onAbort = (): void => {
    if (finished || accepted) return;
    void notify(ui, staleNotice(label), "warning");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    let loaded: PeerReviewSettingsResult<PeerReviewSettingsLoadOutcome> | typeof ABORTED;
    try {
      loaded = await raceAbort(input.load(), signal);
    } catch {
      loaded = { kind: "unknown" };
    }
    if (loaded === ABORTED) return false;
    if (signal?.aborted) return false;
    if (loaded.kind === "not-sent") {
      await notify(ui, notSentNotice(label, loaded.reason), "error");
      return false;
    }
    if (loaded.kind === "unknown") {
      await notify(ui, unknownNotice(label, "load"), "error");
      return false;
    }
    if (loaded.outcome.kind === "refused") {
      await notify(ui, ownerRefusalNotice(label, loaded.outcome.reason, "load"), "error");
      return false;
    }
    if (loaded.outcome.kind === "unknown") {
      await notify(ui, unknownNotice(label, "load"), "error");
      return false;
    }
    let envelope: RemoteReviewSettingsLoadEnvelope;
    try {
      envelope = decodeLoadEnvelope(loaded.outcome.payload);
    } catch {
      // A malformed/forged reply is never partially opened or normalized into
      // something usable, and no raw value or diagnostic is displayed.
      await notify(ui, malformedNotice(label), "error");
      return false;
    }
    if (signal?.aborted) return false;

    const section = { full: targetNotice(label, envelope.firstUse), summary: targetNotice(label, envelope.firstUse) };
    const menuUi = withAbortableUi(ui, signal);
    const targetControl = fenceTargetControl(input.targetControl, signal);
    const backend = createRemoteSaveBackend({
      label,
      ui,
      signal,
      openingId: envelope.openingId,
      save: input.save,
      disconnected: input.disconnected,
      onAccepted: () => {
        accepted = true;
      },
    });
    if (signal?.aborted) return false;
    const outcome = await withSettingsSectionHelp(menuUi, section, async () => {
      // Opening diagnostics are closed codes only, in the local menu's
      // consequence order, so the most severe is the pane's one notice.
      for (const code of envelope.notices) {
        await notify(menuUi, noticeCodeMessage(label, code), code === "tool-protection-invalid" ? "error" : "warning");
      }
      // Screen fencing is not enough here: the shared menu installs its Save
      // control during initialization. Do not start it for an editor that went
      // stale while opening help/notices were settling.
      if (signal?.aborted) throw new RemoteReviewSettingsEditorEnded();
      return await runPersistedReviewSettings({
        // The projected opening is the menu's config: every value came from the
        // owner through the strict decoder, and it is passed through unchanged.
        config: envelope.opening.config,
        // This token never names a requester path and never reaches the owner;
        // the delegating Save backend below owns every destination decision.
        configPath: REMOTE_SETTINGS_CONFIG_PATH,
        ui: menuUi,
        // The owner's own catalogs (including Pi thinking metadata) and no
        // requester-local catalog or tool inventory.
        scoped: envelope.scoped,
        getToolChoices: () => envelope.tools,
        getAuditedToolChoices: () => envelope.tools,
        backend,
        workspaceInput: "owner",
        ...(targetControl === undefined ? {} : { targetControl }),
      });
    });
    // The menu has ended on its own; a later pane/target close is not a stale
    // in-flight editor and must not produce a disconnect warning.
    finished = true;
    // A picker may have accepted before the pane/target/connection went stale
    // while the menu or section-help wrapper was unwinding. Main must not act
    // on a switch from an editor that is no longer current.
    return signal?.aborted !== true && outcome.kind === "switched";
  } catch (error) {
    if (error instanceof RemoteReviewSettingsEditorEnded) return false;
    // Never surface raw object text or diagnostics from an unexpected fault.
    await notify(ui, `${label} Review settings could not be completed.`, "error");
    return false;
  } finally {
    finished = true;
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The fixed, non-path token handed to the shared transaction as its
 * `configPath`. The persisted transaction never resolves or inspects it on this
 * path: the delegating backend receives the staged payload and sends only the
 * closed intent.
 */
const REMOTE_SETTINGS_CONFIG_PATH = "remote-review-settings";

/** One editor-ending Save outcome. Notified before it unwinds the shared menu. */
class RemoteReviewSettingsEditorEnded extends Error {
  constructor() {
    super("review gate: remote review settings editor ended");
    this.name = "RemoteReviewSettingsEditorEnded";
  }
}

interface RemoteSaveBackendInput {
  readonly label: string;
  readonly ui: UiContext;
  readonly signal: AbortSignal | undefined;
  readonly openingId: string;
  readonly save: (payload: Uint8Array) => Promise<PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome>>;
  readonly disconnected: (() => boolean) | undefined;
  readonly onAccepted: () => void;
}

/**
 * The delegating Save backend. It builds the closed intent from the staged
 * payload, checks the exact outbound envelope, sends it once, and maps the
 * owner's closed result onto the shared Save result. No local path, cwd,
 * baseline, provenance, or catalog is sent.
 */
function createRemoteSaveBackend(input: RemoteSaveBackendInput): PersistedSaveBackend {
  const { label, ui, signal, openingId, onAccepted } = input;
  const end = async (message: string): Promise<never> => {
    let disconnected = false;
    try { disconnected = input.disconnected?.() === true; } catch { /* Status is descriptive only. */ }
    await notify(ui, disconnected ? `Save failed: ${label} is disconnected. ${message}` : message, "error");
    throw new RemoteReviewSettingsEditorEnded();
  };
  return {
    async saveStaged(staged: StagedPersistedSave): Promise<PersistedSaveResult> {
      const scheduledTasks = staged.selection.scheduledTasks;
      // Checked strictly BEFORE constructing or handing over any bytes.
      if (signal?.aborted) return await end(notSentNotice(label, "target-unavailable"));
      let intent: RemoteReviewSettingsSaveIntent;
      try {
        // The shared encoder is the only place the staged payload becomes the
        // closed editable intent. It refuses anything with no remote form.
        intent = encodeRemoteReviewSettingsSaveIntent(staged);
      } catch (error) {
        const message = error instanceof RemoteReviewSettingsDataError
          ? error.message
          : `These Review settings cannot be sent to ${label}; nothing was saved.`;
        return { kind: "invalid", scheduledTasks, error: message };
      }
      let payload: Uint8Array;
      try {
        // Exactly the two landed envelope fields; the intent itself already
        // carries only the editable value set.
        const envelope: RemoteReviewSettingsSaveEnvelope = { openingId, intent };
        const bytes = new TextEncoder().encode(JSON.stringify(envelope));
        if (!isReviewSettingsJsonPayload(bytes)) {
          return { kind: "invalid", scheduledTasks, error: `These Review settings are too large to send to ${label}; nothing was saved.` };
        }
        payload = bytes;
      } catch {
        return { kind: "invalid", scheduledTasks, error: `These Review settings cannot be sent to ${label}; nothing was saved.` };
      }
      let result: PeerReviewSettingsResult<PeerReviewSettingsSaveOutcome> | typeof ABORTED;
      try {
        result = await raceAbort(input.save(payload), signal);
      } catch {
        // The callback contract is non-throwing, but a rejected send has still
        // possibly reached the transport: never claim nothing was sent.
        result = { kind: "unknown" };
      }
      if (result === ABORTED) return await end(unknownNotice(label, "save"));
      if (result.kind === "not-sent") return await end(notSentNotice(label, result.reason));
      if (result.kind === "unknown") return await end(unknownNotice(label, "save"));
      if (result.outcome.kind === "accepted") {
        // The ONLY success path: the owner's own positive acceptance.
        onAccepted();
        return {
          kind: "saved",
          // The owner returns no saved config payload; the local menu only
          // ends here, so its own staged draft is the truthful value to carry.
          config: staged.draftConfig,
          scheduledTasks,
          warnings: [],
          // Fixed notices for exactly the entries the owner's shared rule
          // auto-disabled; names come from this editor's own staged draft.
          scheduleDisableWarnings: scheduleDisableNotices(label, result.outcome.receipt, staged),
          scheduleDisableTaskIds: [],
          toolProtectionWarnings: [],
        };
      }
      if (result.outcome.kind === "unknown") return await end(unknownNotice(label, "save"));
      if (result.outcome.reason === "invalid-draft") {
        // The owner kept the opening current: the local draft stays so it can
        // be corrected and saved again.
        return { kind: "invalid", scheduledTasks, error: ownerRefusalNotice(label, result.outcome.reason, "save") };
      }
      if (result.outcome.reason === "conflict") {
        // A definite pre-write refusal with the opening still current: keep the
        // draft available while the notice asks for a review/reopen.
        return { kind: "conflict", scheduledTasks, error: ownerRefusalNotice(label, result.outcome.reason, "save") };
      }
      return await end(ownerRefusalNotice(label, result.outcome.reason, "save"));
    },
  };
}

// ---------------------------------------------------------------------------
// Confirmed auto-disable notices
// ---------------------------------------------------------------------------

/**
 * Fixed notice for one confirmed save's bounded auto-disable receipt. The
 * receipt carries task IDENTITIES only, so each display name is read from this
 * editor's own staged draft (the exact catalogue it sent); an identity with no
 * local entry is shown as itself. It is deliberately ONE notice: the sidebar
 * retains only the last non-error notice when the editor closes, so separate
 * per-task notices would hide every earlier one. The message is bounded (at
 * most {@link MAX_DISABLE_NOTICE_NAMES} single-line names, then an exact
 * count), and the exact remainder is never silently dropped.
 */
function scheduleDisableNotices(
  label: string,
  receipt: ReviewSettingsSaveReceipt | undefined,
  staged: StagedPersistedSave,
): string[] {
  if (receipt === undefined) return [];
  const total = receipt.disabledTaskIds.length + receipt.additionalDisabledCount;
  // The receipt validator forbids a zero total; this is only defensive.
  if (total <= 0) return [];
  const catalog: ScheduledTaskCatalog = staged.draftConfig.scheduledTasks ?? {};
  const names = receipt.disabledTaskIds
    .slice(0, MAX_DISABLE_NOTICE_NAMES)
    .map((id) => `"${displayTaskName(catalog, id)}"`);
  const hidden = total - names.length;
  const listed = names.length === 0 ? "" : `${names.join(", ")}${hidden > 0 ? ` and ${hidden} more` : ""}`;
  if (total === 1) {
    return [names.length === 1
      ? `Scheduled task ${listed} will not run: saving these settings on ${label} disabled it because the worker resource it pins can no longer run it. Choose an available worker on ${label} and enable it again.`
      : `A scheduled task will not run: saving these settings on ${label} disabled it because the worker resource it pins can no longer run it. Choose an available worker on ${label} and enable it again.`];
  }
  const subject = listed.length === 0
    ? `${total} scheduled tasks`
    : listed;
  return [`Scheduled tasks will not run: saving these settings on ${label} disabled ${subject} because their pinned worker resources can no longer run them. Choose available workers on ${label} and enable them again.`];
}

/** How many listed task identities one warning notice names; the rest are counted. */
const MAX_DISABLE_NOTICE_NAMES = 5;
/** Display cap for one task name inside that notice, in code units. */
const MAX_DISABLE_NOTICE_NAME_CHARS = 80;

/**
 * This editor's own staged display name for one task id, collapsed to one line
 * and capped. An absent or blank local name falls back to the validated id.
 */
function displayTaskName(catalog: ScheduledTaskCatalog, id: string): string {
  const raw = Object.hasOwn(catalog, id) ? catalog[id]?.name : undefined;
  const collapsed = typeof raw === "string" ? raw.replace(/\s+/gu, " ").trim() : "";
  const name = collapsed.length === 0 ? id : collapsed;
  return name.length <= MAX_DISABLE_NOTICE_NAME_CHARS
    ? name
    : `${name.slice(0, MAX_DISABLE_NOTICE_NAME_CHARS - 1)}…`;
}

// ---------------------------------------------------------------------------
// Abort/staleness plumbing
// ---------------------------------------------------------------------------

const ABORTED = Symbol("remote-review-settings-aborted");
type AbortSentinel = typeof ABORTED;

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | AbortSentinel> {
  if (signal === undefined) return promise;
  return abortable(promise, signal, ABORTED);
}

/**
 * Resolve with `fallback` as soon as the signal aborts; otherwise settle with
 * the promise. A rejection that arrives after the abort is handled (never an
 * unhandled rejection) and ignored.
 */
function abortable<T, F>(promise: Promise<T>, signal: AbortSignal, fallback: F): Promise<T | F> {
  if (signal.aborted) {
    // The fallback wins, but a late rejection from the live operation must not
    // become an unhandled rejection.
    promise.catch(() => {});
    return Promise.resolve(fallback);
  }
  return new Promise<T | F>((resolve, reject) => {
    let settled = false;
    function finish(): boolean {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      return true;
    }
    function onAbort(): void {
      if (finish()) resolve(fallback);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (finish()) resolve(value);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
  });
}

/**
 * The caller's UI with every waitable surface fenced by the same abort signal.
 * When the pane/target/connection is gone, a pending screen, field, or
 * confirmation resolves exactly as the existing close paths resolve them
 * (cancel/No), so the open menu unwinds and its draft is discarded rather than
 * restored or saved later. Everything else — the host menu TUI, keybindings,
 * theme, cwd, and notices — is delegated unchanged.
 */
function withAbortableUi(ui: UiContext, signal: AbortSignal | undefined): UiContext {
  if (signal === undefined) return ui;
  const wrapped = Object.create(ui) as UiContext;
  // The shared menu attaches its Save control to THIS UI, while the host's
  // confirm/warning-confirm closures read the original UI. Forward both
  // directions so one control keeps the held-key fence and Save suspension.
  Object.defineProperty(wrapped, "saveControl", {
    get: () => ui.saveControl,
    set: (control: UiContext["saveControl"]) => {
      ui.saveControl = control;
    },
    enumerable: true,
    configurable: true,
  });
  // Every call is guarded BEFORE the live UI is touched, so an already-aborted
  // pane can never receive another screen, field, or confirmation call.
  wrapped.select = (title, options) => whenCurrent(signal, undefined, () => ui.select(title, options));
  if (typeof ui.input === "function") {
    wrapped.input = (title, placeholder) => whenCurrent(signal, undefined, () => ui.input!(title, placeholder));
  }
  if (typeof ui.editor === "function") {
    wrapped.editor = (title, prefill) => whenCurrent(signal, undefined, () => ui.editor!(title, prefill));
  }
  if (typeof ui.editText === "function") {
    wrapped.editText = (request) => whenCurrent(signal, undefined, () => ui.editText!(request));
  }
  if (typeof ui.confirm === "function") {
    wrapped.confirm = (title, message) => whenCurrent(signal, false, () => ui.confirm!(title, message));
  }
  if (typeof ui.custom === "function") {
    wrapped.custom = (factory) => whenCurrent(signal, undefined, () => ui.custom!(factory));
  }
  if (ui.settingsWarningConfirm !== undefined) {
    const port = ui.settingsWarningConfirm;
    wrapped.settingsWarningConfirm = {
      confirm: (title, warning, message) => whenCurrent(signal, false, () => port.confirm(title, warning, message)),
    };
  }
  // Notices after a close are not delivered to the live pane either. The
  // adapter's own disconnect notice uses the original UI directly.
  if (ui.notify !== undefined) {
    wrapped.notify = (message, type) => {
      if (!signal.aborted) ui.notify?.(message, type);
    };
  }
  return wrapped;
}

/**
 * Invoke one live UI operation only while the editor is current, then race its
 * result against the signal. The underlying call is never made after abort.
 */
function whenCurrent<T, F>(signal: AbortSignal, fallback: F, call: () => Promise<T>): Promise<T | F> {
  if (signal.aborted) return Promise.resolve(fallback);
  let promise: Promise<T>;
  try {
    promise = call();
  } catch (error) {
    if (signal.aborted) return Promise.resolve(fallback);
    return Promise.reject(error);
  }
  return abortable(promise, signal, fallback);
}

/**
 * Fence the caller's target picker with the editor lifetime. A picker result
 * delivered after the pane/target/connection became stale is not a switch.
 */
function fenceTargetControl(
  control: PersistedReviewSettingsInput["targetControl"],
  signal: AbortSignal | undefined,
): PersistedReviewSettingsInput["targetControl"] {
  if (control === undefined || signal === undefined) return control;
  return {
    label: control.label,
    requestSwitch: async (hasUnsavedChanges: boolean): Promise<boolean> => {
      if (signal.aborted) return false;
      let request: Promise<boolean>;
      try {
        request = Promise.resolve(control.requestSwitch(hasUnsavedChanges));
      } catch (error) {
        if (signal.aborted) return false;
        throw error;
      }
      const result = await abortable(request, signal, ABORTED);
      return result === ABORTED || signal.aborted ? false : result;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixed, truthful notices (no owner text, paths, or diagnostics)
// ---------------------------------------------------------------------------

function staleNotice(label: string): string {
  return `${label} is disconnected or no longer selected; these Review settings were closed.`;
}

function targetNotice(label: string, firstUse: boolean): string {
  return firstUse
    ? `Editing REMOTE review-gate settings for ${label}. No config exists there yet; showing defaults. Save creates it; Cancel leaves it absent. Running sessions on ${label} are not changed.`
    : `Editing REMOTE review-gate settings for ${label}. Saving changes that host's configuration; running sessions are not changed.`;
}

function noticeCodeMessage(label: string, code: RemoteReviewSettingsNoticeCode): string {
  switch (code) {
    case "catalog-warning":
      return `${label} reported a settings catalog warning; some model or tool choices may be unavailable.`;
    case "config-warning":
      return `${label} reported a configuration warning; some saved settings may be unavailable.`;
    case "tool-protection-invalid":
      return `${label} has invalid saved tool-protection settings; protected calls stay blocked until a valid configuration is saved.`;
  }
}

function malformedNotice(label: string): string {
  return `${label} returned Review settings this editor could not read; nothing was opened.`;
}

function notSentNotice(label: string, reason: PeerReviewSettingsNotSentReason): string {
  switch (reason) {
    case "capability-unsupported":
      return `${label} does not offer remote Review settings editing; nothing was sent.`;
    case "not-ready":
      return `The connection to ${label} is not ready; nothing was sent.`;
    case "invalid-request":
      return `The Review settings request to ${label} was not valid; nothing was sent.`;
    case "target-unavailable":
      return `${label} is disconnected or no longer current; nothing was sent.`;
    case "busy":
      return `${label} is busy with another request; nothing was sent.`;
    case "limit":
      return `These Review settings are too large to send to ${label}; nothing was sent.`;
  }
}

function ownerRefusalNotice(label: string, reason: ReviewSettingsRefusalReason, operation: "load" | "save"): string {
  if (operation === "load") {
    switch (reason) {
      case "policy":
        return `${label} did not authorize loading its Review settings; nothing was opened.`;
      case "unavailable":
        return `${label} has no editable Review-gate configuration available.`;
      case "stale":
        return `${label} no longer offers that Review settings draft; nothing was opened.`;
      case "busy":
        return `${label} is busy with another Review settings request; nothing was opened.`;
      case "limit":
        return `These Review settings are too large for ${label}; nothing was opened.`;
      case "invalid-draft":
      case "conflict":
      case "admission":
      case "duplicate":
        return `${label} did not accept the Review settings request; nothing was opened.`;
    }
  }
  switch (reason) {
    case "policy":
      return `${label} did not authorize this Review settings change; nothing was saved.`;
    case "unavailable":
      return `${label} has no editable Review-gate configuration available.`;
    case "stale":
      return `${label} no longer has this Review settings draft open; nothing was saved. Reopen the settings.`;
    case "busy":
      return `${label} is already handling another save of this draft; nothing was saved. Reopen the settings.`;
    case "limit":
      return `These Review settings are too large for ${label}; nothing was saved.`;
    case "invalid-draft":
      return `${label} rejected this draft; nothing was saved. Correct the settings and save again.`;
    case "conflict":
      return `${label} reports external-worker changes on disk; nothing was saved. Reopen the settings to review them.`;
    case "admission":
    case "duplicate":
      return `${label} did not accept the Review settings request; nothing was saved.`;
  }
}

function unknownNotice(label: string, operation: "load" | "save"): string {
  return operation === "load"
    ? `Could not confirm the Review settings load from ${label}; nothing was opened. Reopen to try again.`
    : `Could not confirm whether ${label} saved these Review settings; they may or may not have been saved. Reopen to check.`;
}

// ---------------------------------------------------------------------------
// Strict load-envelope decoding
// ---------------------------------------------------------------------------

class RemoteReviewSettingsViewError extends Error {
  constructor(message: string) {
    super(`review gate: remote review settings ${message}`);
    this.name = "RemoteReviewSettingsViewError";
  }
}

function fail(message: string): never {
  throw new RemoteReviewSettingsViewError(message);
}

const MAX_OPENING_ID = 256;
const MAX_SCOPED_CHOICES = 4_096;
const MAX_TOOL_CHOICES = 8_192;
const MAX_MODEL_ID = 512;
const MAX_SCOPED_LABEL = 1_024;
const MAX_TOOL_NAME = 256;
const MAX_TOOL_DESCRIPTION = 8_192;
const MAX_PRESENTATION_COUNT = 1_000_000;
/**
 * Explicit work bounds for projected collections. The payload ceiling alone
 * does not bound the shared menu's synchronous opening work: it captures a
 * reference baseline for every external worker, and each capture scans the
 * worker catalog, routes, reviewer layers, and every scheduled entry (with its
 * review override). These limits are deliberately generous for an owner
 * configuration while keeping the opening bounded before the first screen.
 */
const MAX_REMOTE_EXTERNAL_AGENTS = 256;
const MAX_REMOTE_WORKER_RESOURCES = 1_024;
const MAX_REMOTE_ROUTE_ENTRIES = 1_024;
const MAX_REMOTE_REVIEWERS = 1_024;
const MAX_REMOTE_SCHEDULED_TASKS = 2_048;
const MAX_REMOTE_TOOL_NAMES = 4_096;
const MAX_REMOTE_PROTECTION_TOOL_NAMES = 4_096;
const MAX_REMOTE_URL_BLOCKLIST = 1_024;
/** (agents + 1) x per-agent reference work; see assertProjectedWorkBudget. */
const MAX_REMOTE_REFERENCE_WORK = 2_000_000;
/** Serialized repeated reference data, multiplied by (agents + 1). */
const MAX_REMOTE_REFERENCE_CODE_UNITS = 32 * 1024 * 1024;

const ENVELOPE_FIELDS = ["openingId", "opening", "scoped", "tools", "firstUse", "notices"] as const;
const OPENING_FIELDS = ["version", "config"] as const;
const PROJECTED_CONFIG_FIELDS = [
  "enabled",
  "operatingMode",
  "modeCycleShortcut",
  "reviewerTimeoutMs",
  "executorTimeoutMs",
  "maxCorrectionCycles",
  "implementationGuidanceAfterCorrectionAttempts",
  "maxPatchBytes",
  "maxFileBytes",
  "maxSnapshotBytes",
  "waveArtifactTtlMs",
  "retainBundles",
  "deleteSpawnedPiSessionsOnCleanup",
  "review",
  "externalAgents",
  "execution",
  "scheduledTasks",
  "ui",
  "youShouldKnow",
  "tools",
  "toolProtection",
  "web",
] as const;
const REVIEW_FIELDS = [
  "primaryReviewers",
  "subtaskReviewers",
  "primaryEnabled",
  "subtaskEnabled",
  "primaryClaudeCodeEnabled",
  "primaryCodexEnabled",
  "reviewLandedChanges",
  "evidence",
] as const;
const EVIDENCE_FIELDS = [
  "primaryToolOnly",
  "worktreeToolOnly",
  "inplaceToolOnly",
  "snapshotFailureFallback",
] as const;
const EXECUTION_FIELDS = [
  "workerResources",
  "routes",
  "maxWorkers",
  "retryPolicy",
  "subtaskNotifications",
  "deferredPiTools",
] as const;
const ROUTES_FIELDS = ["execute", "research"] as const;
const RETRY_POLICY_FIELDS = ["maxRetries", "baseDelayMs", "maxDelayMs", "jitter", "maxSameIncidentRepeats"] as const;
const UI_FIELDS = ["subtasksViewExpanded", "showSubtaskTaskIds"] as const;
const YOU_SHOULD_KNOW_FIELDS = ["enabled", "completionGuidance"] as const;
const TOOLS_FIELDS = ["topLevelDeny", "executorDeny"] as const;
const TOOL_PROTECTION_FIELDS = [
  "level",
  "auditor",
  "scope",
  "toolNames",
  "timeoutMs",
  "maxContextChars",
  "retainAuditorSessions",
  "debug",
] as const;
const WEB_FIELDS = [
  "enabled",
  "browserInteractionApproval",
  "browserIdleExpiryMinutes",
  "browserDownloadRetention",
  "browserVisible",
  "browserPermissions",
  "urlBlocklist",
  "search",
  "fetch",
] as const;
const SEARCH_FIELDS = ["provider", "timeoutMs", "maxResults"] as const;
const FETCH_FIELDS = ["timeoutMs", "maxDownloadBytes", "maxOutputChars", "cacheMaxBytes", "cacheMaxEntries", "userAgent"] as const;
const SCOPED_FIELDS = ["model", "label", "pinnedThinkingLevel", "supportedThinkingLevels"] as const;
const TOOL_FIELDS = ["name", "description"] as const;
const AGENT_FIELDS = ["adapter", "model", "reasoningEffort", "legacyReasoningImport", "review", "execution"] as const;
const ROLE_FIELDS = ["model", "reasoningEffort", "timeoutMs", "legacyReasoningImport"] as const;
const PRESENTATION_FIELDS = ["reasoning", "recognizedSettingCount", "droppedOtherTokenCount", "warnings"] as const;
const SELECTION_FIELDS = ["source", "model", "thinkingLevel", "id"] as const;
const WORKER_RESOURCE_FIELDS = ["selection", "maxConcurrent"] as const;
const ROUTE_FIELDS = ["resourceId", "thinkingLevel"] as const;
const SCHEDULED_TASK_FIELDS = [
  "name",
  "cron",
  "enabled",
  "kind",
  "destination",
  "instructions",
  "workspace",
  "workerResourceId",
  "review",
  "oneShot",
  "alreadyRun",
] as const;
const SCHEDULED_TASK_REQUIRED_FIELDS = ["name", "cron", "enabled", "kind", "instructions", "workspace"] as const;
const SCHEDULED_REVIEW_FIELDS = ["mode", "reviewers"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  // JSON.parse only produces plain objects, arrays, and primitives; rejecting
  // arrays here is the complete shape guard this boundary needs.
  return isRecord(value);
}

function closedRecord(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field} has an unsupported field`);
  }
  return value;
}

function closedRecordWithKeys(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  const record = closedRecord(value, field, allowed);
  for (const key of allowed) {
    if (!Object.hasOwn(record, key)) fail(`${field} is missing ${key}`);
  }
  return record;
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail(`${field} must be a non-empty bounded string`);
  }
  return value;
}

function optionalBoundedString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, field, max);
}

function optionalBoundedText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > max) fail(`${field} must be a bounded string`);
  return value;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function count(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_PRESENTATION_COUNT) {
    fail(`${field} must be a bounded non-negative integer`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${field} must be a positive integer`);
  }
  return value;
}

function boundedArray(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) fail(`${field} exceeds the remote Review settings limit`);
  return value;
}

function boundedRecord(value: unknown, field: string, max: number): Record<string, unknown> {
  if (!isPlainRecord(value)) fail(`${field} must be an object`);
  if (Object.keys(value).length > max) fail(`${field} exceeds the remote Review settings limit`);
  return value;
}

/**
 * Shape check for one projected reviewer/auditor/worker selection. Value
 * grammar (non-empty model/id, valid thinking level) stays with the shared
 * canonical validators; this rejects missing or source-inapplicable fields the
 * projection never emits.
 */
function decodeSelectionShape(
  value: unknown,
  field: string,
  options: { allowThinkingLevel: boolean },
): void {
  const record = closedRecord(value, field, SELECTION_FIELDS);
  if (record.source === "pi") {
    if (!Object.hasOwn(record, "model")) fail(`${field} is missing model`);
    if (Object.hasOwn(record, "id")) fail(`${field} has an id for a pi selection`);
    if (!options.allowThinkingLevel && Object.hasOwn(record, "thinkingLevel")) {
      fail(`${field} must not carry resource-level thinking`);
    }
    return;
  }
  if (record.source === "external") {
    if (!Object.hasOwn(record, "id")) fail(`${field} is missing id`);
    if (Object.hasOwn(record, "model") || Object.hasOwn(record, "thinkingLevel")) {
      fail(`${field} has pi-only fields for an external selection`);
    }
    return;
  }
  fail(`${field}.source must be "pi" or "external"`);
}

function decodeWorkerResourceShape(value: unknown, field: string): void {
  const record = closedRecord(value, field, WORKER_RESOURCE_FIELDS);
  if (!Object.hasOwn(record, "selection")) fail(`${field} is missing selection`);
  if (!Object.hasOwn(record, "maxConcurrent")) fail(`${field} is missing maxConcurrent`);
  decodeSelectionShape(record.selection, `${field}.selection`, { allowThinkingLevel: false });
}

function decodeRouteShape(value: unknown, field: string): void {
  const record = closedRecord(value, field, ROUTE_FIELDS);
  if (!Object.hasOwn(record, "resourceId")) fail(`${field} is missing resourceId`);
}

function decodeScheduledReviewShape(value: unknown, field: string): number {
  const record = closedRecord(value, field, SCHEDULED_REVIEW_FIELDS);
  if (record.mode === "off") {
    if (Object.hasOwn(record, "reviewers")) fail(`${field} has reviewers with mode off`);
    return 0;
  }
  if (record.mode === "selected") {
    if (!Object.hasOwn(record, "reviewers")) fail(`${field} is missing reviewers`);
    const reviewers = boundedArray(record.reviewers, `${field}.reviewers`, MAX_REMOTE_REVIEWERS);
    for (const [index, reviewer] of reviewers.entries()) {
      decodeSelectionShape(reviewer, `${field}.reviewers[${index}]`, { allowThinkingLevel: true });
    }
    return reviewers.length;
  }
  fail(`${field}.mode must be off or selected`);
}

/**
 * Shape check for one projected scheduled entry; returns its selected-review
 * reference weight for the aggregate work budget. The owner projection always
 * emits the required fields, so a missing/corrupt one is a malformed reply, not
 * a draft for the shared menu to default.
 */
function decodeScheduledTaskShape(value: unknown, field: string): number {
  const record = closedRecord(value, field, SCHEDULED_TASK_FIELDS);
  for (const key of SCHEDULED_TASK_REQUIRED_FIELDS) {
    if (!Object.hasOwn(record, key)) fail(`${field} is missing ${key}`);
  }
  // The canonical parser rejects step "0" but not zero-padded spellings like
  // "00"; its loop advances by the converted number, so a zero step would hang
  // synchronously before any abort could be honored. Reject zero steps here and
  // leave all other cron validation canonical.
  if (typeof record.cron !== "string" || /\/0+(?=[,\s]|$)/u.test(record.cron)) {
    fail(`${field}.cron must be a string with positive steps`);
  }
  return record.review === undefined
    ? 0
    : decodeScheduledReviewShape(record.review, `${field}.review`);
}

interface ProjectedWorkCounts {
  externalAgents: number;
  workerResources: number;
  executeRoute: number;
  researchRoute: number;
  primaryReviewers: number;
  subtaskReviewers: number;
  scheduledTasks: number;
  scheduledReviewers: number;
}

/**
 * Bound the product of external workers and the reference data the shared menu
 * scans once per worker at open. A 4 MiB payload alone permits combinations
 * whose synchronous baseline capture would stall the requester.
 */
function assertProjectedWorkBudget(counts: ProjectedWorkCounts, referenceValues: readonly unknown[]): void {
  const perAgent = counts.workerResources
    + counts.executeRoute
    + counts.researchRoute
    + counts.primaryReviewers
    + counts.subtaskReviewers
    + counts.scheduledTasks
    + counts.scheduledReviewers
    + 1;
  const work = (counts.externalAgents + 1) * perAgent;
  if (!Number.isSafeInteger(work) || work > MAX_REMOTE_REFERENCE_WORK) {
    fail("opening.config exceeds the remote Review settings work limit");
  }
  // Target-switch dirty tracking serializes every captured per-agent reference
  // baseline. Bound the repeated reference payload itself, not only the number
  // of visits: a long retained model string can repeat for every agent.
  const referenceSize = JSON.stringify(referenceValues).length;
  if ((counts.externalAgents + 1) * referenceSize > MAX_REMOTE_REFERENCE_CODE_UNITS) {
    fail("opening.config exceeds the remote Review settings reference size limit");
  }
}

function decodeLoadEnvelope(payload: Uint8Array): RemoteReviewSettingsLoadEnvelope {
  if (!isReviewSettingsJsonPayload(payload)) fail("load payload is not a bounded JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    fail("load payload is not valid JSON");
  }
  const envelope = closedRecordWithKeys(parsed, "load envelope", ENVELOPE_FIELDS);
  const openingId = boundedString(envelope.openingId, "load envelope.openingId", MAX_OPENING_ID);
  const opening = closedRecordWithKeys(envelope.opening, "load envelope.opening", OPENING_FIELDS);
  if (opening.version !== REMOTE_REVIEW_SETTINGS_DATA_VERSION) {
    fail("load envelope.opening.version is unsupported");
  }
  return {
    openingId,
    opening: {
      version: REMOTE_REVIEW_SETTINGS_DATA_VERSION,
      config: decodeProjectedConfig(opening.config),
    },
    scoped: decodeScoped(envelope.scoped),
    tools: decodeTools(envelope.tools),
    firstUse: boolean(envelope.firstUse, "load envelope.firstUse"),
    notices: decodeNotices(envelope.notices),
  };
}

function decodeScoped(value: unknown): ScopedModelChoice[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPED_CHOICES) fail("load envelope.scoped must be a bounded array");
  return value.map((entry, index) => {
    const field = `load envelope.scoped[${index}]`;
    const record = closedRecord(entry, field, SCOPED_FIELDS);
    const model = boundedString(record.model, `${field}.model`, MAX_MODEL_ID);
    const label = boundedString(record.label, `${field}.label`, MAX_SCOPED_LABEL);
    const supportedThinkingLevels = decodeThinkingLevels(record.supportedThinkingLevels, `${field}.supportedThinkingLevels`);
    const pinnedThinkingLevel = record.pinnedThinkingLevel === undefined
      ? undefined
      : thinkingLevel(record.pinnedThinkingLevel, `${field}.pinnedThinkingLevel`);
    return {
      model,
      label,
      ...(pinnedThinkingLevel === undefined ? {} : { pinnedThinkingLevel }),
      supportedThinkingLevels,
    };
  });
}

function decodeThinkingLevels(value: unknown, field: string): ThinkingLevel[] {
  if (!Array.isArray(value) || value.length > THINKING_LEVELS.length) fail(`${field} must be a bounded array`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const level = thinkingLevel(entry, `${field}[${index}]`);
    if (seen.has(level)) fail(`${field}[${index}] is duplicated`);
    seen.add(level);
    return level;
  });
}

function thinkingLevel(value: unknown, field: string): ThinkingLevel {
  if (typeof value !== "string" || !(THINKING_LEVELS as readonly string[]).includes(value)) {
    fail(`${field} must be a thinking level`);
  }
  return value as ThinkingLevel;
}

function decodeTools(value: unknown): RemoteReviewSettingsToolChoice[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CHOICES) fail("load envelope.tools must be a bounded array");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const field = `load envelope.tools[${index}]`;
    const record = closedRecord(entry, field, TOOL_FIELDS);
    const name = boundedString(record.name, `${field}.name`, MAX_TOOL_NAME);
    if (name !== name.trim()) fail(`${field}.name must not have surrounding whitespace`);
    if (seen.has(name)) fail(`${field}.name is duplicated`);
    seen.add(name);
    const description = optionalBoundedText(record.description, `${field}.description`, MAX_TOOL_DESCRIPTION);
    return { name, ...(description === undefined ? {} : { description }) };
  });
}

function decodeNotices(value: unknown): RemoteReviewSettingsNoticeCode[] {
  if (!Array.isArray(value) || value.length > REMOTE_REVIEW_SETTINGS_NOTICE_CODES.length) {
    fail("load envelope.notices must be a bounded array");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== "string" || !(REMOTE_REVIEW_SETTINGS_NOTICE_CODES as readonly string[]).includes(entry)) {
      fail("load envelope.notices has an unsupported code");
    }
    if (seen.has(entry)) fail("load envelope.notices has a duplicate code");
    seen.add(entry);
    return entry as RemoteReviewSettingsNoticeCode;
  });
}

/**
 * Decode the owner's projected opening. The editable sections are handed to the
 * shared canonical normalizer (with canonical stand-ins for the projected
 * external-worker definitions, which intentionally have no command). The
 * projected definitions themselves are preserved exactly, and every
 * non-editable projection default is replaced by this build's own default.
 */
function decodeProjectedConfig(value: unknown): ReviewGateConfig {
  const config = closedRecordWithKeys(value, "opening.config", PROJECTED_CONFIG_FIELDS);
  const review = closedRecordWithKeys(config.review, "opening.config.review", REVIEW_FIELDS);
  closedRecordWithKeys(review.evidence, "opening.config.review.evidence", EVIDENCE_FIELDS);
  const primaryReviewers = boundedArray(review.primaryReviewers, "opening.config.review.primaryReviewers", MAX_REMOTE_REVIEWERS);
  for (const [index, reviewer] of primaryReviewers.entries()) {
    decodeSelectionShape(reviewer, `opening.config.review.primaryReviewers[${index}]`, { allowThinkingLevel: true });
  }
  const subtaskReviewers = boundedArray(review.subtaskReviewers, "opening.config.review.subtaskReviewers", MAX_REMOTE_REVIEWERS);
  for (const [index, reviewer] of subtaskReviewers.entries()) {
    decodeSelectionShape(reviewer, `opening.config.review.subtaskReviewers[${index}]`, { allowThinkingLevel: true });
  }
  const execution = closedRecordWithKeys(config.execution, "opening.config.execution", EXECUTION_FIELDS);
  const routes = closedRecordWithKeys(execution.routes, "opening.config.execution.routes", ROUTES_FIELDS);
  const executeRoute = boundedArray(routes.execute, "opening.config.execution.routes.execute", MAX_REMOTE_ROUTE_ENTRIES);
  for (const [index, route] of executeRoute.entries()) {
    decodeRouteShape(route, `opening.config.execution.routes.execute[${index}]`);
  }
  const researchRoute = boundedArray(routes.research, "opening.config.execution.routes.research", MAX_REMOTE_ROUTE_ENTRIES);
  for (const [index, route] of researchRoute.entries()) {
    decodeRouteShape(route, `opening.config.execution.routes.research[${index}]`);
  }
  closedRecordWithKeys(execution.retryPolicy, "opening.config.execution.retryPolicy", RETRY_POLICY_FIELDS);
  const workerResources = boundedRecord(execution.workerResources, "opening.config.execution.workerResources", MAX_REMOTE_WORKER_RESOURCES);
  for (const [id, resource] of Object.entries(workerResources)) {
    decodeWorkerResourceShape(resource, `opening.config.execution.workerResources.${id}`);
  }
  const ui = closedRecordWithKeys(config.ui, "opening.config.ui", UI_FIELDS);
  for (const key of UI_FIELDS) boolean(ui[key], `opening.config.ui.${key}`);
  const youShouldKnow = closedRecordWithKeys(config.youShouldKnow, "opening.config.youShouldKnow", YOU_SHOULD_KNOW_FIELDS);
  for (const key of YOU_SHOULD_KNOW_FIELDS) boolean(youShouldKnow[key], `opening.config.youShouldKnow.${key}`);
  const tools = closedRecordWithKeys(config.tools, "opening.config.tools", TOOLS_FIELDS);
  boundedArray(tools.topLevelDeny, "opening.config.tools.topLevelDeny", MAX_REMOTE_TOOL_NAMES);
  boundedArray(tools.executorDeny, "opening.config.tools.executorDeny", MAX_REMOTE_TOOL_NAMES);
  const toolProtection = closedRecordWithKeys(config.toolProtection, "opening.config.toolProtection", TOOL_PROTECTION_FIELDS);
  if (toolProtection.auditor !== null) {
    decodeSelectionShape(toolProtection.auditor, "opening.config.toolProtection.auditor", { allowThinkingLevel: true });
  }
  boundedArray(toolProtection.toolNames, "opening.config.toolProtection.toolNames", MAX_REMOTE_PROTECTION_TOOL_NAMES);
  const web = closedRecordWithKeys(config.web, "opening.config.web", WEB_FIELDS);
  closedRecordWithKeys(web.browserPermissions, "opening.config.web.browserPermissions", BROWSER_PERMISSION_FIELDS);
  const search = closedRecordWithKeys(web.search, "opening.config.web.search", SEARCH_FIELDS);
  if (search.provider !== DEFAULT_CONFIG.web!.search.provider) {
    fail("opening.config.web.search.provider is unsupported");
  }
  const fetch = closedRecordWithKeys(web.fetch, "opening.config.web.fetch", FETCH_FIELDS);
  // normalizeWeb substitutes its default for a null/absent user agent, so the
  // projected slot is checked here before any local default replaces it.
  if (typeof fetch.userAgent !== "string") fail("opening.config.web.fetch.userAgent must be a string");
  boundedArray(web.urlBlocklist, "opening.config.web.urlBlocklist", MAX_REMOTE_URL_BLOCKLIST);
  const scheduledTasks = boundedRecord(config.scheduledTasks, "opening.config.scheduledTasks", MAX_REMOTE_SCHEDULED_TASKS);
  let scheduledReviewers = 0;
  // Only the repeated reference data, never schedule instructions or workspaces.
  const scheduledReferences: unknown[] = [];
  for (const [id, entry] of Object.entries(scheduledTasks)) {
    scheduledReviewers += decodeScheduledTaskShape(entry, `opening.config.scheduledTasks.${id}`);
    const record = entry as Record<string, unknown>;
    scheduledReferences.push([id, record.workerResourceId, record.review]);
  }
  const agents = decodeExternalAgents(config.externalAgents);
  assertProjectedWorkBudget({
    externalAgents: Object.keys(agents.catalog).length,
    workerResources: Object.keys(workerResources).length,
    executeRoute: executeRoute.length,
    researchRoute: researchRoute.length,
    primaryReviewers: primaryReviewers.length,
    subtaskReviewers: subtaskReviewers.length,
    scheduledTasks: Object.keys(scheduledTasks).length,
    scheduledReviewers,
  }, [workerResources, executeRoute, researchRoute, primaryReviewers, subtaskReviewers, scheduledReferences]);

  let normalized: ReviewGateConfig;
  try {
    normalized = normalizeConfig({
      enabled: config.enabled,
      operatingMode: config.operatingMode,
      modeCycleShortcut: config.modeCycleShortcut,
      reviewerTimeoutMs: config.reviewerTimeoutMs,
      executorTimeoutMs: config.executorTimeoutMs,
      maxCorrectionCycles: config.maxCorrectionCycles,
      implementationGuidanceAfterCorrectionAttempts: config.implementationGuidanceAfterCorrectionAttempts,
      // Validate the projected non-editable defaults even though the result
      // below always uses this build's own defaults.
      maxPatchBytes: config.maxPatchBytes,
      maxFileBytes: config.maxFileBytes,
      maxSnapshotBytes: config.maxSnapshotBytes,
      waveArtifactTtlMs: config.waveArtifactTtlMs,
      retainBundles: config.retainBundles,
      deleteSpawnedPiSessionsOnCleanup: config.deleteSpawnedPiSessionsOnCleanup,
      review,
      // Canonical stand-ins validate every reference the menu relies on
      // (worker resources, scheduled pins, research capability) without
      // pretending a projected definition has a command.
      externalAgents: agents.validation,
      execution,
      scheduledTasks,
      ui,
      youShouldKnow,
      tools,
      toolProtection,
      web,
    });
  } catch {
    fail("opening.config is not a valid projected configuration");
  }
  const canonicalExecution = normalized.execution;
  const canonicalWeb = normalized.web!;
  return {
    ...normalized,
    // The projection never carries these non-editable values from the owner:
    // always use this build's own bounded defaults.
    maxPatchBytes: DEFAULT_CONFIG.maxPatchBytes,
    maxFileBytes: DEFAULT_CONFIG.maxFileBytes,
    maxSnapshotBytes: DEFAULT_CONFIG.maxSnapshotBytes,
    externalAgents: agents.catalog,
    ...(canonicalExecution === undefined ? {} : {
      execution: {
        ...canonicalExecution,
        workerResources: withoutResourceThinkingCatalog(canonicalExecution.workerResources ?? {}),
      },
    }),
    web: {
      ...canonicalWeb,
      enabled: DEFAULT_CONFIG.web!.enabled,
      search: { ...DEFAULT_CONFIG.web!.search },
      fetch: { ...DEFAULT_CONFIG.web!.fetch, maxDownloadBytes: canonicalWeb.fetch.maxDownloadBytes },
    },
  };
}

interface ProjectedExternalAgentRole {
  model?: string;
  reasoningEffort?: NativeReasoningEffort;
  timeoutMs?: number;
  legacyReasoningImport?: ReasoningImportPresentation;
}

/** One projected external-worker definition: editable values and presentation only. */
interface ProjectedExternalAgent {
  adapter: ExternalAgentAdapter;
  model?: string;
  reasoningEffort?: NativeReasoningEffort;
  legacyReasoningImport?: ReasoningImportPresentation;
  review?: ProjectedExternalAgentRole;
  execution?: ProjectedExternalAgentRole;
}

interface DecodedExternalAgents {
  /** The exact projected catalog the menu receives. */
  readonly catalog: ExternalAgentCatalog;
  /** Canonical, command-bearing stand-ins used only for shared validation. */
  readonly validation: ExternalAgentCatalog;
}

function decodeExternalAgents(value: unknown): DecodedExternalAgents {
  if (!isPlainRecord(value)) fail("opening.config.externalAgents must be an object");
  const entries = Object.entries(value);
  if (entries.length > MAX_REMOTE_EXTERNAL_AGENTS) {
    fail("opening.config.externalAgents exceeds the remote Review settings limit");
  }
  const catalog: Record<string, unknown> = {};
  const validation: Record<string, unknown> = {};
  for (const [id, entry] of entries) {
    const field = `opening.config.externalAgents.${id}`;
    const decoded = decodeExternalAgent(entry, field);
    setCatalogKey(catalog, id, decoded);
    setCatalogKey(validation, id, validationDefinition(decoded));
  }
  return { catalog: catalog as ExternalAgentCatalog, validation: validation as ExternalAgentCatalog };
}

function decodeExternalAgent(value: unknown, field: string): ProjectedExternalAgent {
  const record = closedRecord(value, field, AGENT_FIELDS);
  const adapter = externalAgentAdapter(record.adapter, `${field}.adapter`);
  const guided = isGuidedAdapter(adapter);
  const agent: ProjectedExternalAgent = { adapter };
  const model = optionalBoundedString(record.model, `${field}.model`, MAX_MODEL_ID);
  if (model !== undefined) agent.model = model;
  if (record.reasoningEffort !== undefined) {
    if (!guided) fail(`${field}.reasoningEffort is unsupported for this adapter`);
    agent.reasoningEffort = nativeReasoningEffort(adapter, record.reasoningEffort, `${field}.reasoningEffort`);
  }
  if (record.legacyReasoningImport !== undefined) {
    if (!guided) fail(`${field}.legacyReasoningImport is unsupported for this adapter`);
    agent.legacyReasoningImport = decodePresentation(record.legacyReasoningImport, adapter, `${field}.legacyReasoningImport`);
  }
  if (record.review !== undefined) agent.review = decodeProjectedRole(record.review, adapter, `${field}.review`);
  if (record.execution !== undefined) agent.execution = decodeProjectedRole(record.execution, adapter, `${field}.execution`);
  if (agent.review === undefined && agent.execution === undefined) fail(`${field} must have at least one role`);
  return agent;
}

function decodeProjectedRole(value: unknown, adapter: ExternalAgentAdapter, field: string): ProjectedExternalAgentRole {
  const record = closedRecord(value, field, ROLE_FIELDS);
  const guided = isGuidedAdapter(adapter);
  const role: ProjectedExternalAgentRole = {};
  const model = optionalBoundedString(record.model, `${field}.model`, MAX_MODEL_ID);
  if (model !== undefined) role.model = model;
  if (record.reasoningEffort !== undefined) {
    if (!guided) fail(`${field}.reasoningEffort is unsupported for this adapter`);
    role.reasoningEffort = nativeReasoningEffort(adapter, record.reasoningEffort, `${field}.reasoningEffort`);
  }
  if (record.timeoutMs !== undefined) role.timeoutMs = positiveInteger(record.timeoutMs, `${field}.timeoutMs`);
  if (record.legacyReasoningImport !== undefined) {
    if (!guided) fail(`${field}.legacyReasoningImport is unsupported for this adapter`);
    role.legacyReasoningImport = decodePresentation(record.legacyReasoningImport, adapter, `${field}.legacyReasoningImport`);
  }
  return role;
}

/**
 * Build the canonical definition used only to let the shared normalizer
 * validate ids, models, timeouts, reasoning grammar, adapter/role
 * combinations, and scheduled-task references. It never reaches the menu and
 * its injected command/protocol is discarded.
 */
function validationDefinition(decoded: ProjectedExternalAgent): ExternalAgentValue {
  const definition: ExternalAgentValue = {
    adapter: decoded.adapter,
    command: decoded.adapter === "claude-cli" ? "claude" : decoded.adapter === "codex-cli" ? "codex" : "remote-review-settings",
    ...(decoded.model !== undefined ? { model: decoded.model } : {}),
    ...(decoded.reasoningEffort !== undefined ? { reasoningEffort: decoded.reasoningEffort } : {}),
    ...(decoded.review !== undefined ? { review: validationRole(decoded.review, decoded.adapter, "review") } : {}),
    ...(decoded.execution !== undefined ? { execution: validationRole(decoded.execution, decoded.adapter, "execution") } : {}),
  };
  return definition;
}

function validationRole(
  role: ProjectedExternalAgentRole,
  adapter: ExternalAgentAdapter,
  kind: "review" | "execution",
): ExternalAgentRoleConfig {
  return {
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.reasoningEffort !== undefined ? { reasoningEffort: role.reasoningEffort } : {}),
    ...(role.timeoutMs !== undefined ? { timeoutMs: role.timeoutMs } : {}),
    // A projected run-as-binary role carries no protocol by design; the
    // canonical validator requires the matching one, so the stand-in supplies
    // it. No other adapter requires a protocol here.
    ...(adapter === "run-as-binary" ? {
      protocol: kind === "review" ? "pi-reviewer-json-v1" as const : "pi-review-executor-jsonl-v1" as const,
    } : {}),
  };
}

function decodePresentation(
  value: unknown,
  adapter: GuidedExternalAgentAdapter,
  field: string,
): ReasoningImportPresentation {
  const record = closedRecordWithKeys(value, field, PRESENTATION_FIELDS);
  return {
    reasoning: decodeReasoningImport(record.reasoning, adapter, `${field}.reasoning`),
    recognizedSettingCount: count(record.recognizedSettingCount, `${field}.recognizedSettingCount`),
    droppedOtherTokenCount: count(record.droppedOtherTokenCount, `${field}.droppedOtherTokenCount`),
    warnings: decodeWarnings(record.warnings, `${field}.warnings`),
  };
}

function decodeReasoningImport(value: unknown, adapter: GuidedExternalAgentAdapter, field: string): ReasoningImport {
  const record = isPlainRecord(value) ? value : fail(`${field} must be an object`);
  if (record.kind === "absent") {
    closedRecord(record, field, ["kind"]);
    return { kind: "absent" };
  }
  if (record.kind === "value") {
    closedRecord(record, field, ["kind", "value"]);
    const level = record.value;
    if (typeof level !== "string" || level === "default" || !isNativeReasoningEffort(adapter, level)) {
      fail(`${field}.value must be a native effort level`);
    }
    return { kind: "value", value: level as ExternalAgentEffortLevel };
  }
  if (record.kind === "unresolved") {
    closedRecord(record, field, ["kind", "reason"]);
    if (record.reason !== "conflicting" && record.reason !== "malformed-or-unknown") {
      fail(`${field}.reason is unsupported`);
    }
    return { kind: "unresolved", reason: record.reason };
  }
  return fail(`${field}.kind is unsupported`);
}

const REASONING_WARNINGS: readonly ReasoningWarning[] = Object.freeze([
  "identical-duplicates",
  "conflicting-effort",
  "malformed-or-unknown-effort",
  "stale-literal-effort",
]);

function decodeWarnings(value: unknown, field: string): ReasoningWarning[] {
  if (!Array.isArray(value) || value.length > REASONING_WARNINGS.length) fail(`${field} must be a bounded array`);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== "string" || !(REASONING_WARNINGS as readonly string[]).includes(entry)) {
      fail(`${field} has an unsupported warning code`);
    }
    if (seen.has(entry)) fail(`${field} has a duplicate warning code`);
    seen.add(entry);
    return entry as ReasoningWarning;
  });
}

function externalAgentAdapter(value: unknown, field: string): ExternalAgentAdapter {
  if (value === "claude-cli" || value === "codex-cli" || value === "generic-cli" || value === "run-as-binary") {
    return value;
  }
  return fail(`${field} is not a supported external-worker adapter`);
}

function isGuidedAdapter(adapter: ExternalAgentAdapter): adapter is GuidedExternalAgentAdapter {
  return adapter === "claude-cli" || adapter === "codex-cli";
}

function nativeReasoningEffort(
  adapter: GuidedExternalAgentAdapter,
  value: unknown,
  field: string,
): NativeReasoningEffort {
  if (!isNativeReasoningEffort(adapter, value)) fail(`${field} is not a supported native effort`);
  return value;
}
