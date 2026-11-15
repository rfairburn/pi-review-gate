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
import type { NativeStatusObservation } from "./native-status";

/** Owner-only construction context; no provider conversation is created here. */
export type NativeObserverFactoryContext = Pick<NativeClaudeAcquisitionOptions, "rowId" | "backend"> & {
  readonly emit: (observation: NativeStatusObservation) => void;
};

/** Construct one independent observation source for one already-owned native run. */
export function createNativeStatusObserver(context: NativeObserverFactoryContext) {
  const options = { rowId: context.rowId, backend: context.backend, onSnapshot: context.emit };
  if (context.backend === "claude") {
    const controller = new NativeClaudeAcquisitionController(options);
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
