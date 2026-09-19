import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type BrowserConsequence =
  | "ordinary_navigation"
  | "local_disclosure"
  | "local_editing"
  | "sensitive_input"
  | "autosave_or_change"
  | "download"
  | "authentication"
  | "terms_or_consent"
  | "permissions"
  | "destructive"
  | "publish"
  | "send"
  | "purchase"
  | "account_change"
  | "form_submission"
  | "unknown_or_mixed"
  // Produced only by the manager's issue #27 file-transfer operations
  // (BrowserUpload / BrowserDownloadSave), never by structural classification.
  | "file_upload"
  | "file_download_save"
  // Produced only by the manager's issue #27 model clipboard operations
  // (BrowserClipboard), never by structural classification.
  | "clipboard_read"
  | "clipboard_write";

/** Structural facts read from the exact semantic-ref target. Accessible text is intentionally absent. */
export interface BrowserTargetStructure {
  tagName: string;
  role: string | null;
  href: string | null;
  target: string | null;
  download: boolean;
  inputType: string | null;
  formAssociated: boolean;
  formAction: string | null;
  formMethod: string | null;
  ariaHasPopup: string | null;
  contentEditable: boolean;
  disabled: boolean;
  inlineEventHandler: boolean;
  summaryForDetails: boolean;
  /** Form-control facts are optional for compatibility with pre-form snapshots; absence fails closed. */
  autocomplete?: string | null;
  readOnly?: boolean;
  multiple?: boolean;
  explicitChangeHandler?: boolean;
  explicitSubmitHandler?: boolean;
  /** True only when the caller can prove relevant page listeners are absent. */
  pageControlledEventsAbsent?: boolean;
  /**
   * True when the target's owning form structurally contains a
   * password/credential field (password-type input or an explicit
   * current/new-password autocomplete token). Computed from structure only:
   * no field value is ever read, so human-entered content is detected the
   * same way as model-entered content.
   */
  formHasCredentialField?: boolean;
  domPath: string;
}

export interface BrowserConsequenceDecision {
  consequence: BrowserConsequence;
  consequential: boolean;
  destination: string | null;
}

export type BrowserFormOperation = "fill" | "type" | "select" | "press";

/** Exact mouse button for BrowserClick; only left and right are supported. */
export type BrowserClickButton = "left" | "right";

export interface BrowserFormAction {
  operation: BrowserFormOperation;
  key?: string;
}

/**
 * Central browser consequence policy. It accepts structural browser facts only;
 * callers cannot provide a safety assertion and accessible names never enter a decision.
 */
export class BrowserConsequencePolicy {
  /**
   * Classify one click target for the exact mouse button. A right-click never
   * performs the ordinary left-button action: it can only reach page-controlled
   * contextmenu/mouse handlers, whose effects cannot be proven absent. The
   * silent ordinary-left-link exemption therefore never applies to it.
   */
  classify(target: BrowserTargetStructure, button: BrowserClickButton = "left"): BrowserConsequenceDecision {
    const decision = this.classifyLeftButton(target);
    if (button === "right" && !decision.consequential) {
      return { consequence: "unknown_or_mixed", consequential: true, destination: null };
    }
    return decision;
  }

  private classifyLeftButton(target: BrowserTargetStructure): BrowserConsequenceDecision {
    const destination = normalizedHttpUrl(target.href ?? target.formAction);
    if (target.download) return { consequence: "download", consequential: true, destination };
    if (target.inputType === "file") return { consequence: "permissions", consequential: true, destination };

    // GET-shaped links can themselves perform consequential work. Inspect the
    // structural destination before making an anchor eligible for the silent,
    // controlled-navigation path.
    const linkConsequence = target.href ? consequenceFromDestination(target.href) : undefined;
    if (linkConsequence) return { consequence: linkConsequence, consequential: true, destination };

    const formConsequence = target.formAssociated || isSubmitControl(target)
      ? consequenceFromDestination(target.formAction) ?? "form_submission"
      : undefined;
    if (formConsequence) return { consequence: formConsequence, consequential: true, destination };

    const nativeLink = (target.tagName === "a" || target.tagName === "area")
      && (target.role === null || target.role === "link")
      && destination !== null;
    // New browsing contexts require a real click and therefore cannot bypass
    // page handlers; keep them consequential rather than silently dispatching.
    const ordinaryTarget = target.target === null || target.target === "" || target.target === "_self";
    if (
      nativeLink
      && ordinaryTarget
      && !target.disabled
      && !target.inlineEventHandler
      && !target.ariaHasPopup
      && !target.contentEditable
    ) {
      return { consequence: "ordinary_navigation", consequential: false, destination };
    }

    if (
      target.tagName === "summary"
      && target.summaryForDetails
      && (target.role === null || target.role === "button")
      && !target.disabled
      && !target.inlineEventHandler
      && !target.ariaHasPopup
      && !target.contentEditable
      && !target.href
    ) {
      // Even a native open-state change queues a page-controlled toggle event.
      // No reliable absence-of-effects proof exists; use the approval path.
      return { consequence: "local_disclosure", consequential: true, destination: null };
    }

    return { consequence: "unknown_or_mixed", consequential: true, destination };
  }

  classifyForm(target: BrowserTargetStructure, action: BrowserFormAction): BrowserConsequenceDecision {
    const destination = normalizedHttpUrl(target.formAction);
    if (target.inputType === "file") return { consequence: "permissions", consequential: true, destination };
    if (target.inputType === "password") return { consequence: "authentication", consequential: true, destination };

    const formDestination = consequenceFromDestination(target.formAction);
    if (formDestination) return { consequence: formDestination, consequential: true, destination };

    const autocomplete = target.autocomplete === undefined || target.autocomplete === null
      ? null
      : target.autocomplete.trim().toLocaleLowerCase("en-US");
    if (autocomplete !== null && autocomplete !== "off") {
      const authentication = /(?:^|\s)(?:current-password|new-password|one-time-code|username|webauthn)(?:\s|$)/.test(autocomplete);
      return {
        consequence: authentication ? "authentication" : "sensitive_input",
        consequential: true,
        destination,
      };
    }
    if (target.inputType === "email" || target.inputType === "tel") {
      return { consequence: "sensitive_input", consequential: true, destination };
    }
    if (target.explicitChangeHandler || target.explicitSubmitHandler) {
      return { consequence: "autosave_or_change", consequential: true, destination };
    }
    if (action.operation === "press" && isActivationKey(action.key)) {
      return {
        consequence: target.formAssociated || isSubmitControl(target) ? "form_submission" : "unknown_or_mixed",
        consequential: true,
        destination,
      };
    }
    if (isProvenLocalEditingTarget(target, action.operation)) {
      return { consequence: "local_editing", consequential: false, destination };
    }
    return { consequence: "unknown_or_mixed", consequential: true, destination };
  }

  fingerprint(target: BrowserTargetStructure): string {
    // Fixed field order makes the fingerprint deterministic and excludes names,
    // values, page text, and arbitrary attributes.
    return createHash("sha256").update(JSON.stringify([
      target.tagName, target.role, target.href, target.target, target.download,
      target.inputType, target.formAssociated, target.formAction, target.formMethod,
      target.ariaHasPopup, target.contentEditable, target.disabled,
      target.inlineEventHandler, target.summaryForDetails, target.autocomplete,
      target.readOnly, target.multiple, target.explicitChangeHandler,
      target.explicitSubmitHandler, target.pageControlledEventsAbsent,
      target.formHasCredentialField, target.domPath,
    ])).digest("base64url");
  }
}

export interface BrowserConfirmationBinding {
  session: string;
  tab: string;
  generation: string;
  operation:
    | "click"
    | BrowserFormOperation
    // Issue #27 model file-transfer operations (BrowserUpload /
    // BrowserDownloadSave). They reuse the same single-use, digest-bound
    // permit flow as consequential page interactions.
    | "upload"
    | "download_save"
    // Issue #27 model clipboard operations (BrowserClipboard, text only).
    // Writes bind the exact value by digest and length; reads bind none.
    | "clipboard_read"
    | "clipboard_write";
  ref: string;
  origin: string;
  destination: string | null;
  targetFingerprint: string;
  consequence: BrowserConsequence;
  /** Exact values are represented only by a process-local digest and lengths. */
  valueDigest: string | null;
  valueLengths: readonly number[];
  key: string | null;
  /** Exact mouse button for click operations; null for non-click operations. */
  button: BrowserClickButton | null;
  /**
   * Verified real source paths for an upload operation (issue #27). The page
   * never sees or chooses these; they are bound into the permit digest and
   * re-verified against size/mtime before dispatch.
   */
  sourceFiles?: readonly string[] | null;
  /** Verified real destination path for a download-save operation (issue #27). */
  destinationPath?: string | null;
  /** Whether the verified destination file already existed at classification time. */
  destinationExisted?: boolean | null;
  /** Opaque pending-download handle bound to a download-save approval. */
  downloadHandle?: string | null;
  /**
   * Issue #141 coordinate-click targeting. `point` is the viewport-image
   * (CSS pixel) position from the tab's last successful viewport-mode
   * screenshot, and `viewport` records the exact viewport dimensions the
   * capture was taken at; the click is temporarily re-applied to those
   * dimensions before dispatch. Both are absent for ref clicks.
   */
  point?: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}

export interface BrowserConfirmationPermit {
  readonly id: string;
  readonly expiresAt: number;
}

interface StoredPermit {
  expiresAt: number;
  digest: Buffer;
}

/** Process-local, single-use confirmation permits with an absolute deadline. */
export class BrowserConfirmationPermits {
  private readonly permits = new Map<string, StoredPermit>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly randomId: () => string = () => randomBytes(24).toString("base64url"),
    private readonly lifetimeMs = 30_000,
  ) {}

  issue(binding: BrowserConfirmationBinding): BrowserConfirmationPermit {
    this.prune();
    const id = this.randomId();
    const expiresAt = this.now() + this.lifetimeMs;
    this.permits.set(id, { expiresAt, digest: bindingDigest(binding, expiresAt) });
    return Object.freeze({ id, expiresAt });
  }

  consume(permit: BrowserConfirmationPermit, binding: BrowserConfirmationBinding): boolean {
    const stored = this.permits.get(permit.id);
    // Delete before every check: denial, timeout, mismatch, and success all make it unusable.
    this.permits.delete(permit.id);
    if (!stored || stored.expiresAt !== permit.expiresAt || this.now() >= stored.expiresAt) return false;
    const actual = bindingDigest(binding, stored.expiresAt);
    return actual.length === stored.digest.length && timingSafeEqual(actual, stored.digest);
  }

  revoke(permit: BrowserConfirmationPermit): void {
    this.permits.delete(permit.id);
  }

  clear(): void {
    this.permits.clear();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, permit] of this.permits) if (now >= permit.expiresAt) this.permits.delete(id);
  }
}

function bindingDigest(binding: BrowserConfirmationBinding, expiresAt: number): Buffer {
  return createHash("sha256").update(JSON.stringify([
    binding.session, binding.tab, binding.generation, binding.operation, binding.ref,
    binding.origin, binding.destination, binding.targetFingerprint, binding.consequence,
    binding.valueDigest, binding.valueLengths, binding.key, binding.button,
    // Issue #27 file-transfer facts. Absent for pre-existing operations.
    binding.sourceFiles ?? null, binding.destinationPath ?? null,
    binding.destinationExisted ?? null, binding.downloadHandle ?? null,
    // Issue #141 coordinate-click facts. Absent for ref clicks.
    binding.point ?? null, binding.viewport ?? null,
    expiresAt,
  ])).digest();
}

export function isActivationKey(key: string | undefined): boolean {
  if (!key) return false;
  const base = key.split("+").at(-1);
  return base === "Enter" || base === "Space";
}

function isProvenLocalEditingTarget(target: BrowserTargetStructure, operation: BrowserFormOperation): boolean {
  if (
    target.readOnly === undefined
    || target.explicitChangeHandler === undefined
    || target.explicitSubmitHandler === undefined
    || !("autocomplete" in target)
    || target.pageControlledEventsAbsent !== true
    || target.disabled
    || target.readOnly
    || target.inlineEventHandler
    || target.ariaHasPopup
    || target.download
    || target.href
  ) return false;
  if (operation === "select") {
    return target.multiple !== undefined
      && target.tagName === "select"
      && (target.role === null || target.role === "listbox" || target.role === "combobox");
  }
  const textInput = target.tagName === "input"
    && (target.role === null || target.role === "textbox" || target.role === "searchbox")
    && ["text", "search", "url", "number"].includes(target.inputType ?? "");
  const editable = textInput
    || (target.tagName === "textarea" && (target.role === null || target.role === "textbox"))
    || (target.contentEditable && (target.role === null || target.role === "textbox"));
  if (operation === "fill" || operation === "type") return editable;
  // Non-activation keys are local only on a proven editable control (including
  // native select state). Other targets remain unknown and require confirmation.
  const nativeSelect = target.multiple !== undefined
    && target.tagName === "select"
    && (target.role === null || target.role === "listbox" || target.role === "combobox");
  return operation === "press" && (editable || nativeSelect);
}

export function isSubmitControl(target: BrowserTargetStructure): boolean {
  // Per HTML, a button's missing or invalid type value is in the Submit Button
  // state (HTMLButtonElement.type reflects "submit"), so only the explicit
  // reset/button states do not submit the form on activation.
  if (target.tagName === "button") return target.inputType !== "reset" && target.inputType !== "button";
  return target.tagName === "input" && (target.inputType === "submit" || target.inputType === "image");
}

/**
 * Structural definition of a password/credential field: a password-type input
 * or an explicit current/new-password autocomplete token. It never reads, is
 * given, or compares any field value, so the model cannot detect a human's
 * password by echoing it; presence is proven from the DOM structure alone.
 */
export function isCredentialFieldTarget(target: BrowserTargetStructure): boolean {
  if (target.inputType === "password") return true;
  const tokens = target.autocomplete?.trim().toLocaleLowerCase("en-US").split(/\s+/) ?? [];
  return tokens.includes("current-password") || tokens.includes("new-password");
}

/**
 * True when a key press on this target activates form submission: Enter from
 * any form-associated control (implicit submission), or Space on a non-text
 * control (button/select activation). Space inside a text control types a
 * character, so it is entry rather than activation.
 */
function pressActivatesSubmission(key: string | undefined, target: BrowserTargetStructure): boolean {
  if (!key) return false;
  const base = key.split("+").at(-1);
  if (base === "Enter") return true;
  if (base !== "Space") return false;
  return target.tagName !== "input" && target.tagName !== "textarea" && !target.contentEditable;
}

/**
 * Issue #27 credential-entry gate: which model form actions enter values into
 * a password/credential field. Fill and type always do; a press does so only
 * when it is not the activation that submits the form (that case is governed
 * by the submission gate, including for human-entered passwords). Click, hover,
 * and select never enter field values.
 */
export function modelActionRequiresCredentialEntry(
  operation: "click" | BrowserFormOperation,
  key: string | undefined,
  target: BrowserTargetStructure,
): boolean {
  if (!isCredentialFieldTarget(target)) return false;
  if (operation === "fill" || operation === "type") return true;
  if (operation === "press") return !pressActivatesSubmission(key, target);
  return false;
}

/**
 * Issue #27 credential-submission gate: which model actions submit a form that
 * structurally contains credentials. Only real submission activations qualify:
 * a click on a native submit control, or an activation-key press in a form
 * context. Filling, selecting, and ordinary navigation (including to
 * authenticated routes) never do, so non-credential forms and post-login
 * browsing are unaffected by the gate.
 */
export function modelActionSubmitsCredentialForm(
  operation: "click" | BrowserFormOperation,
  key: string | undefined,
  target: BrowserTargetStructure,
): boolean {
  const credentialForm = target.formHasCredentialField === true;
  if (operation === "click") return credentialForm && isSubmitControl(target);
  if (operation === "press") {
    if (!pressActivatesSubmission(key, target)) return false;
    // An activation press on a credential control itself always activates the
    // submission of its associated form, even when the owning form's credential
    // membership could not be proven from descendant structure (for example a
    // form="id" association outside the form element). Shadow-root-internal
    // controls remain outside that structural proof; this rule still covers an
    // activation press on the credential control itself.
    return isCredentialFieldTarget(target) || (credentialForm && (target.formAssociated || isSubmitControl(target)));
  }
  return false;
}

function consequenceFromDestination(raw: string | null): BrowserConsequence | undefined {
  if (!raw) return undefined;
  let path: string;
  try { path = new URL(raw).pathname.toLocaleLowerCase("en-US"); }
  catch { return "unknown_or_mixed"; }
  if (/(?:^|\/)(?:login|logout|signin|signout|oauth|session)(?:\/|$)/.test(path)) return "authentication";
  if (/(?:^|\/)(?:terms|consent|agreement)(?:\/|$)/.test(path)) return "terms_or_consent";
  if (/(?:^|\/)(?:permission|permissions|authorize)(?:\/|$)/.test(path)) return "permissions";
  if (/(?:^|\/)(?:delete|remove|destroy|revoke)(?:\/|$)/.test(path)) return "destructive";
  if (/(?:^|\/)(?:publish)(?:\/|$)/.test(path)) return "publish";
  if (/(?:^|\/)(?:send|message)(?:\/|$)/.test(path)) return "send";
  if (/(?:^|\/)(?:buy|purchase|checkout|order)(?:\/|$)/.test(path)) return "purchase";
  if (/(?:^|\/)(?:account|profile|settings)(?:\/|$)/.test(path)) return "account_change";
  return undefined;
}

function normalizedHttpUrl(raw: string | null): string | null {
  if (!raw || raw.length > 4_096) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
