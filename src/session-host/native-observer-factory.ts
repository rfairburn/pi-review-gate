import {
  NativeClaudeAcquisitionController,
  NATIVE_CLAUDE_ACQUISITION_SUPPORT,
  type NativeClaudeAcquisitionOptions,
} from "./native-claude-acquisition";
import {
  NativeCodexAcquisitionController,
  NATIVE_CODEX_ACQUISITION_SUPPORT,
} from "./native-codex-acquisition";
import type { NativeHookEvent, NativeHookFailure } from "./native-hook-protocol";
import { createOwnedNativeCodexStatusObserver } from "./native-codex-owned-status";
import type { NativeStatusObserverContext, NativeStatusObserverFactory } from "./instances";
import type { NativeStatusObservation } from "./native-status";

/**
 * Owner-only construction context; no provider conversation is created here.
 *
 * The optional owner-private fields are exactly the manager's own context
 * (issue #277, and the #690 title channel): the row's canonical workspace, the
 * exact admitted restoration UUID this run must still prove, the separate identity
 * channel, and the separate ephemeral conversation-title channel. They are
 * forwarded only to the source that consumes them; none of them is ever folded
 * into a {@link NativeStatusObservation}.
 */
export type NativeObserverFactoryContext = Pick<NativeClaudeAcquisitionOptions, "rowId" | "backend"> & {
  readonly emit: (observation: NativeStatusObservation) => void;
} & Pick<
  NativeStatusObserverContext,
  | "workspace"
  | "resumeConversationId"
  | "emitConversationIdentity"
  | "emitConversationTitle"
  | "emitRootToolRequest"
  | "emitRootTranscriptRebound"
>;

/** The owner-private identity and title inputs one consuming source receives, absent fields omitted. */
function identityOptions(context: NativeObserverFactoryContext): {
  readonly workspace?: string;
  readonly resumeConversationId?: string;
  readonly onConversationIdentity?: (conversationId: string | null) => boolean;
  readonly onConversationTitle?: (conversationId: string, title: string | null) => boolean;
} {
  return {
    ...(context.workspace === undefined ? {} : { workspace: context.workspace }),
    ...(context.resumeConversationId === undefined ? {} : { resumeConversationId: context.resumeConversationId }),
    ...(context.emitConversationIdentity === undefined
      ? {}
      : { onConversationIdentity: context.emitConversationIdentity }),
    ...(context.emitConversationTitle === undefined
      ? {}
      : { onConversationTitle: context.emitConversationTitle }),
  };
}

/** Construct one independent observation source for one already-owned native run. */
export function createNativeStatusObserver(context: NativeObserverFactoryContext) {
  const options = { rowId: context.rowId, backend: context.backend, onSnapshot: context.emit };
  if (context.backend === "claude") {
    // Claude proves its own root conversation from its authenticated hooks, so it
    // alone of the legacy sources receives the owner-private identity inputs.
    const controller = new NativeClaudeAcquisitionController({
      ...options,
      ...identityOptions(context),
      // #682: the per-dispatch root tool-request verdict is Claude-only.
      ...(context.emitRootToolRequest === undefined ? {} : { onRootToolRequest: context.emitRootToolRequest }),
      ...(context.emitRootTranscriptRebound === undefined
        ? {}
        : { onRootTranscriptRebound: context.emitRootTranscriptRebound }),
    });
    return Object.freeze({
      support: NATIVE_CLAUDE_ACQUISITION_SUPPORT,
      // Keep hook dispatch synchronous: Claude takes its read barrier before the broker ACK.
      acceptHook: (event: NativeHookEvent): void => controller.acceptHook(event),
      acceptFailure: (failure: NativeHookFailure): void => controller.acceptFailure(failure),
      invalidate: (): void => controller.invalidate(),
      // The one baseline the host may state from its own spawn. Only the Claude
      // route can vouch for a launch-time empty baseline today, so the hook is
      // deliberately absent for Codex rather than guessed at: that source keeps
      // its unknown-until-first-record behaviour until its own visibility path is
      // ready.
      observeOwnedStartup: (): void => controller.observeOwnedStartup(),
      dispose: (): void => controller.dispose(),
    });
  }
  if (context.backend === "codex") {
    // The legacy Codex hook lane proves no conversation identity; it is unchanged.
    const controller = new NativeCodexAcquisitionController(options);
    return Object.freeze({
      support: NATIVE_CODEX_ACQUISITION_SUPPORT,
      acceptHook: (event: NativeHookEvent): void => controller.acceptHook(event),
      acceptFailure: (failure: NativeHookFailure): void => controller.acceptFailure(failure),
      invalidate: (): void => controller.invalidate(),
      dispose: (): void => controller.dispose(),
    });
  }
  throw new RangeError("native status observation requires a native CLI backend");
}

/**
 * The owning host's internal opt-in for the owned Codex observation route.
 *
 * It is a construction-time property of one host, set by the host that also
 * injects an owned Codex backend factory: never a user setting, never a
 * per-request field, and never something a peer, a wire frame, or a provider can
 * claim. Absent or false — every existing call site — the factory this module has
 * always supplied is returned unchanged, so a Pi, Claude, or ordinary standalone
 * Codex row keeps its exact legacy hook lane and its exact applicability
 * declaration.
 */
export interface NativeObserverFactoryHostOptions {
  /** Route a genuinely owned Codex run to its read-only RPC lane (default false). */
  readonly ownedCodexBackend?: boolean;
}

/**
 * Build one host's observer factory. With the opt-in set, a Codex run is wrapped
 * by the owned-aware consumer: it starts as the exact legacy source above and
 * switches to the read-only RPC lane only when the manager hands that run its own
 * owned-backend capability, so a host that opted in but whose provider composed an
 * ordinary descriptor receives no capability and keeps the legacy lane entirely.
 * Claude and Pi routes are never wrapped, whatever the host opted into.
 */
export function createNativeStatusObserverFactory(
  host: NativeObserverFactoryHostOptions = {},
): NativeStatusObserverFactory {
  if (host.ownedCodexBackend !== undefined && typeof host.ownedCodexBackend !== "boolean") {
    throw new TypeError("native observer factory ownedCodexBackend must be a boolean or absent");
  }
  const ownedCodexBackend = host.ownedCodexBackend === true;
  return (context) => {
    // The legacy source is always built first: until a capability proves this run
    // is owned, it is the only source, with the only declaration it ever had.
    const legacy = createNativeStatusObserver(context);
    if (!ownedCodexBackend || context.backend !== "codex") return legacy;
    // The owned consumer validates a restoring run and proves its identity on the
    // read-only RPC lane; the legacy source it wraps stays exactly as built above.
    return createOwnedNativeCodexStatusObserver({ legacy, emit: context.emit, ...identityOptions(context) });
  };
}
