import type { BrowserInteractionApproval, WebBrowserPermissions, WebConfig } from "../config";

/**
 * Issue #27 browser-permission foundation: the pure effective-capability and
 * approval calculation for the independently selectable `web.browserPermissions`
 * settings. This module is deliberately free of runtime, networking, and UI
 * dependencies so the egress/network worker (which consumes an injected
 * `allowLocalNetworks` boolean) and the interactive-browser enforcement can
 * both consume one shared contract.
 *
 * Semantics:
 * - Every capability defaults to off; default browser behavior is unchanged
 *   unless a capability is explicitly enabled.
 * - Capability toggles constrain model actions only. Human credential/form
 *   submission and file uploads remain allowed regardless of the model-only
 *   toggles; `localNetworks` applies to human and model navigation alike.
 * - Model upload/download file selection and side effects follow the existing
 *   Ask / Automatically Accept / Automatically Deny interaction-approval
 *   policy; no mandatory human file picker is introduced by these settings.
 * - `yolo` is the master override: it enables every browser capability and
 *   bypasses per-action approval prompts, including an otherwise configured
 *   Ask or Automatically Deny policy. It never silently leaves a supposedly
 *   disabled restriction in force.
 * - YOLO approvals are policy (automatic) approvals. Callers must report them
 *   as automatic and must never fabricate a human-confirmed result; the
 *   effective mode under YOLO is therefore always "automatically-accept",
 *   which is the only mode that acts without prompting or claiming a human.
 * - Browser host/session ownership and the authenticated control transport are
 *   preserved; these settings grant no cross-session or arbitrary host-command
 *   authority. Every capability in this contract is enforced at runtime by the
 *   interactive-browser manager (tool-action gates, per-origin permission
 *   grants, launch-pinned context modes, and the egress broker); see the
 *   Browser permissions section of docs/web-tools.md for the exact semantics.
 */
export interface EffectiveBrowserPolicy {
  /** True when the YOLO master override is active. */
  readonly yolo: boolean;
  /**
   * Effective per-action interaction-approval mode. Under YOLO this is always
   * "automatically-accept": consequential actions proceed with policy approval
   * and no prompt, even when the stored policy is "ask" or
   * "automatically-deny". Approvals granted under YOLO are automatic and must
   * never be reported as human confirmation.
   */
  readonly interactionApproval: BrowserInteractionApproval;
  /** Model may enter values into password/credential fields. */
  readonly modelCredentialEntry: boolean;
  /** Model may submit forms containing credentials. Human submission is unaffected. */
  readonly modelCredentialSubmission: boolean;
  /** Model may upload files; selection and side effects follow the approval policy. */
  readonly modelUploads: boolean;
  /** Model may save downloads to disk; selection and side effects follow the approval policy. */
  readonly modelDownloadSaving: boolean;
  /** Model may read from and write to the host clipboard. */
  readonly modelClipboard: boolean;
  /** Model-driven browser sessions may use the camera. */
  readonly modelCamera: boolean;
  /** Model-driven browser sessions may use the microphone. */
  readonly modelMicrophone: boolean;
  /** Model-driven browser sessions may request geolocation. */
  readonly modelGeolocation: boolean;
  /** Service workers are allowed in the managed browser. */
  readonly modelServiceWorkers: boolean;
  /** The current popup restriction is lifted for the managed browser. */
  readonly modelPopupRestrictionOverride: boolean;
  /** Human and model navigation may reach loopback, private, and link-local addresses. */
  readonly localNetworks: boolean;
}

/**
 * Compute the effective browser capability/approval policy from the stored
 * a-la-carte permissions and the configured per-action interaction-approval
 * mode. Pure and total: it never consults the environment, runtime state, or
 * UI, and it changes no stored values (YOLO preserves the individual settings
 * beneath the master override so disabling restores them).
 */
export function effectiveBrowserPolicy(
  permissions: WebBrowserPermissions,
  interactionApproval: BrowserInteractionApproval,
): EffectiveBrowserPolicy {
  const yolo = permissions.yolo === true;
  return {
    yolo,
    interactionApproval: yolo ? "automatically-accept" : interactionApproval,
    modelCredentialEntry: yolo || permissions.modelCredentialEntry === true,
    modelCredentialSubmission: yolo || permissions.modelCredentialSubmission === true,
    modelUploads: yolo || permissions.modelUploads === true,
    modelDownloadSaving: yolo || permissions.modelDownloadSaving === true,
    modelClipboard: yolo || permissions.modelClipboard === true,
    modelCamera: yolo || permissions.modelCamera === true,
    modelMicrophone: yolo || permissions.modelMicrophone === true,
    modelGeolocation: yolo || permissions.modelGeolocation === true,
    modelServiceWorkers: yolo || permissions.modelServiceWorkers === true,
    modelPopupRestrictionOverride: yolo || permissions.modelPopupRestrictionOverride === true,
    localNetworks: yolo || permissions.localNetworks === true,
  };
}

/** Convenience form over a normalized `web` configuration block. */
export function effectiveBrowserPolicyForWeb(web: WebConfig): EffectiveBrowserPolicy {
  return effectiveBrowserPolicy(web.browserPermissions, web.browserInteractionApproval);
}
