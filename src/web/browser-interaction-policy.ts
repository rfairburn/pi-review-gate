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
  | "unknown_or_mixed";

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
  domPath: string;
}

export interface BrowserConsequenceDecision {
  consequence: BrowserConsequence;
  consequential: boolean;
  destination: string | null;
}

export type BrowserFormOperation = "fill" | "type" | "select" | "press";

export interface BrowserFormAction {
  operation: BrowserFormOperation;
  key?: string;
}

/**
 * Central browser consequence policy. It accepts structural browser facts only;
 * callers cannot provide a safety assertion and accessible names never enter a decision.
 */
export class BrowserConsequencePolicy {
  classify(target: BrowserTargetStructure): BrowserConsequenceDecision {
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
      return { consequence: "local_disclosure", consequential: false, destination: null };
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
      target.explicitSubmitHandler, target.pageControlledEventsAbsent, target.domPath,
    ])).digest("base64url");
  }
}

export interface BrowserConfirmationBinding {
  session: string;
  tab: string;
  generation: string;
  operation: "click" | BrowserFormOperation;
  ref: string;
  origin: string;
  destination: string | null;
  targetFingerprint: string;
  consequence: BrowserConsequence;
  /** Exact values are represented only by a process-local digest and lengths. */
  valueDigest: string | null;
  valueLengths: readonly number[];
  key: string | null;
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
    binding.valueDigest, binding.valueLengths, binding.key, expiresAt,
  ])).digest();
}

function isActivationKey(key: string | undefined): boolean {
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

function isSubmitControl(target: BrowserTargetStructure): boolean {
  if (target.tagName === "button") return target.inputType === null || target.inputType === "submit";
  return target.tagName === "input" && (target.inputType === "submit" || target.inputType === "image");
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
