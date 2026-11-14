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
  const controller = context.backend === "claude"
    ? new NativeClaudeAcquisitionController(options)
    : context.backend === "codex"
      ? new NativeCodexAcquisitionController(options)
      : undefined;
  if (controller === undefined) throw new RangeError("native status observation requires a native CLI backend");

  return Object.freeze({
    support: context.backend === "claude" ? NATIVE_CLAUDE_ACQUISITION_SUPPORT : NATIVE_CODEX_ACQUISITION_SUPPORT,
    // Keep hook dispatch synchronous: Claude takes its read barrier before the broker ACK.
    acceptHook: (event: NativeHookEvent): void => controller.acceptHook(event),
    acceptFailure: (failure: NativeHookFailure): void => controller.acceptFailure(failure),
    invalidate: (): void => controller.invalidate(),
    dispose: (): void => controller.dispose(),
  });
}
