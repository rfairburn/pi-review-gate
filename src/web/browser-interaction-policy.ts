import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type BrowserConsequence =
  | "ordinary_navigation"
  | "local_disclosure"
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
  domPath: string;
}

export interface BrowserConsequenceDecision {
  consequence: BrowserConsequence;
  consequential: boolean;
  destination: string | null;
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

  fingerprint(target: BrowserTargetStructure): string {
    // Fixed field order makes the fingerprint deterministic and excludes names,
    // values, page text, and arbitrary attributes.
    return createHash("sha256").update(JSON.stringify([
      target.tagName, target.role, target.href, target.target, target.download,
      target.inputType, target.formAssociated, target.formAction, target.formMethod,
      target.ariaHasPopup, target.contentEditable, target.disabled,
      target.inlineEventHandler, target.summaryForDetails, target.domPath,
    ])).digest("base64url");
  }
}

export interface BrowserConfirmationBinding {
  session: string;
  tab: string;
  generation: string;
  operation: "click";
  ref: string;
  origin: string;
  destination: string | null;
  targetFingerprint: string;
  consequence: BrowserConsequence;
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
    expiresAt,
  ])).digest();
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
