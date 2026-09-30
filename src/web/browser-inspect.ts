/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for semantic inspection — the bounded semantic detail reader used by
 * BrowserInspect, its fixed computed-role allowlists and sanitization, and
 * the ARIA snapshot-root parser that produces the captured semantics stored
 * per opaque ref. All page reads stay inside Playwright's own isolated
 * accessibility/utility engines (including the fixed accessible-description
 * assertion bridge); nothing here evaluates page-world JavaScript and every
 * malformed or unsupported read fails closed.
 */
import type { Locator, Page } from "playwright";
import { boundedUntrustedText, diagnosticPublicOrigin } from "./browser-diagnostics.js";
import type { InteractiveBrowserLimits } from "./browser-limits.js";
import { settleBrowserReads } from "./browser-operations.js";
import { throwIfAborted } from "./browser-primitives.js";
import { identifySemanticTag, ownerDocumentBaseUrl } from "./browser-target-structure.js";

/** Computed semantics captured for one opaque ref by the last snapshot read. */
export interface CapturedAriaSemantic {
  role: string | null;
  name: string;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  expanded: boolean | null;
  selected: boolean | null;
  focused: boolean;
}

export interface BrowserInspectResult {
  session: string;
  tab: string;
  generation: string;
  ref: string;
  semantic: {
    role: string | null;
    tag: string;
    type: string | null;
    accessibleName: string;
    accessibleDescription: string;
    states: {
      checked: boolean | "mixed" | null;
      disabled: boolean;
      expanded: boolean | null;
      selected: boolean | null;
      focused: boolean;
      editable: boolean;
    };
    hrefOrigin: string | null;
    visibleText: {
      text: string;
      returnedChars: number;
      truncated: boolean;
      suppressed: boolean;
    };
  };
  untrusted: true;
}

function semanticToken(value: unknown, maxChars: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const token = value.trim().toLocaleLowerCase("en-US");
  return /^[a-z][a-z0-9_-]*$/.test(token) ? token.slice(0, maxChars) : fallback;
}

function nullableSemanticToken(value: unknown, maxChars: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  const token = semanticToken(value, maxChars, "");
  return token || null;
}

function implicitSemanticRole(tag: string, type: string | null): string | null {
  if (tag === "a" || tag === "area") return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag !== "input") return null;
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (["button", "submit", "reset", "image"].includes(type ?? "")) return "button";
  if (type === "range") return "slider";
  return "textbox";
}

interface RawSemanticDetail {
  role: string | null;
  tag: string;
  type: string | null;
  accessibleName: string;
  accessibleDescription: string;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  expanded: boolean | null;
  selected: boolean | null;
  focused: boolean;
  editable: boolean;
  href: string | null;
  visibleText: string;
  visibleTextTruncated: boolean;
  textSuppressed: boolean;
}

const INSPECT_COMPUTED_ROLE_ALLOWLIST = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion",
  "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
  "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup",
  "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "strong",
  "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time",
  "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

const INSPECT_CHECKED_ROLES = new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "option", "radio", "switch", "treeitem"]);
const INSPECT_EXPANDED_ROLES = new Set([
  "application", "button", "checkbox", "columnheader", "combobox", "gridcell", "link", "listbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "row", "rowheader", "switch", "tab", "treeitem",
]);
const INSPECT_SELECTED_ROLES = new Set(["columnheader", "gridcell", "option", "row", "rowheader", "tab", "treeitem"]);

export async function readSemanticDetail(
  locator: Locator,
  page: Page,
  computed: CapturedAriaSemantic,
  limits: { text: number; name: number; description: number },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RawSemanticDetail> {
  const timeout = Math.max(1, timeoutMs);
  const attributesPromise = settleBrowserReads([
    locator.getAttribute("type", { timeout }),
    locator.getAttribute("href", { timeout }),
    locator.getAttribute("aria-checked", { timeout }),
    locator.getAttribute("aria-expanded", { timeout }),
    locator.getAttribute("aria-selected", { timeout }),
  ]);
  const tagPromise = identifySemanticTag(locator, page);
  const disabledPromise = locator.isDisabled({ timeout });
  const focusedPromise = locator.and(page.locator(":focus")).count().then((count) => count === 1);
  // A second ariaSnapshot call rewrites Playwright's aria-ref registry and
  // would silently stale sibling opaque refs. Revalidate the captured computed
  // role/name and read current computed states through fixed getByRole filters
  // instead; these use Playwright's isolated accessibility engine without
  // changing the ref registry or entering the page's main world.
  const semanticsCurrentPromise = verifyComputedSemantic(locator, page, computed);
  const [attributes, tag, disabled, focused] = await settleBrowserReads([
    attributesPromise, tagPromise, disabledPromise, focusedPromise, semanticsCurrentPromise,
  ]);
  throwIfAborted(signal);
  const [typeAttribute, hrefAttribute, ariaChecked, ariaExpanded, ariaSelected] = attributes;
  const type = tag === "input" || tag === "button" ? nullableSemanticToken(typeAttribute?.slice(0, 33), 32) : null;
  const editingHost = locator.locator('xpath=ancestor-or-self::*[@contenteditable][1]');
  const contentEditable = await editingHost.count() ? (await editingHost.getAttribute("contenteditable", { timeout }))?.toLowerCase() : null;
  const mayBeEditable = tag === "input" || tag === "textarea" || tag === "select"
    || contentEditable === "" || contentEditable === "true" || contentEditable === "plaintext-only"
    || computed.role === "textbox" || computed.role === "combobox" || computed.role === "searchbox";
  const editable = mayBeEditable ? await locator.isEditable({ timeout }) : false;
  const checkedState = await currentComputedBoolean(locator, page, computed, "checked", INSPECT_CHECKED_ROLES);
  const expandedState = tag === "summary"
    ? await currentDisclosureState(locator, page)
    : await currentComputedBoolean(locator, page, computed, "expanded", INSPECT_EXPANDED_ROLES);
  const selectedState = await currentComputedBoolean(locator, page, computed, "selected", INSPECT_SELECTED_ROLES);
  const textSuppressed = editable || tag === "input" || tag === "textarea" || tag === "select";
  const visibleText = textSuppressed ? "" : await locator.innerText({ timeout });
  throwIfAborted(signal);
  const description = await readComputedDescription(locator, limits.description);
  let href: string | null = null;
  if ((tag === "a" || tag === "area") && hrefAttribute !== null) {
    const documentBase = await ownerDocumentBaseUrl(locator);
    try { href = diagnosticPublicOrigin(new URL(hrefAttribute, documentBase).href); }
    catch { href = null; }
  }
  const normalizedVisibleText = visibleText.slice(0, limits.text + 1).replace(/\s+/gu, " ").trim();
  return {
    role: nullableSemanticToken(computed.role, 64),
    tag,
    type,
    accessibleName: computed.name.slice(0, limits.name + 1),
    accessibleDescription: description,
    checked: ariaBooleanOrMixed(ariaChecked) ?? checkedState,
    disabled,
    expanded: expandedState ?? ariaBoolean(ariaExpanded),
    selected: selectedState ?? ariaBoolean(ariaSelected),
    focused,
    editable,
    href,
    visibleText: normalizedVisibleText,
    visibleTextTruncated: normalizedVisibleText.length > limits.text,
    textSuppressed,
  };
}

async function currentComputedBoolean(
  locator: Locator,
  page: Page,
  semantic: CapturedAriaSemantic,
  state: "checked" | "expanded" | "selected",
  supportedRoles: ReadonlySet<string>,
): Promise<boolean | null> {
  if (!semantic.role || !supportedRoles.has(semantic.role)) return null;
  const role = semantic.role as Parameters<Page["getByRole"]>[0];
  const common = { name: semantic.name, exact: true };
  const [trueMatches, falseMatches] = await settleBrowserReads([
    locator.and(page.getByRole(role, { ...common, [state]: true })).count(),
    locator.and(page.getByRole(role, { ...common, [state]: false })).count(),
  ]);
  if (trueMatches === 1) return true;
  if (falseMatches === 1) return false;
  return null;
}

async function currentDisclosureState(locator: Locator, page: Page): Promise<boolean | null> {
  const [open, closed] = await settleBrowserReads([
    locator.and(page.locator("details[open] > summary")).count(),
    locator.and(page.locator("details:not([open]) > summary")).count(),
  ]);
  return open === 1 ? true : closed === 1 ? false : null;
}

export function parseAriaRoot(snapshot: string): CapturedAriaSemantic {
  const first = snapshot.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const role = /^-\s+([a-z][a-z0-9_-]*)\b/u.exec(first)?.[1] ?? null;
  const quoted = /^-\s+[a-z][a-z0-9_-]*\s+("(?:\\.|[^"\\])*")/u.exec(first)?.[1];
  let name = "";
  if (quoted) {
    try { name = JSON.parse(quoted) as string; }
    catch { name = ""; }
  }
  const checkedValue = /\[checked=(mixed|true|false)\]/u.exec(first)?.[1];
  const checked = checkedValue === "mixed" ? "mixed"
    : checkedValue === "true" ? true
      : checkedValue === "false" ? false
        : /\[checked\]/u.test(first) ? true : null;
  return {
    role,
    name,
    checked,
    disabled: /\[disabled\]/u.test(first),
    expanded: /\[expanded\]/u.test(first) ? true : /\[expanded=false\]/u.test(first) ? false : null,
    selected: /\[selected\]/u.test(first) ? true : /\[selected=false\]/u.test(first) ? false : null,
    focused: /\[active\]/u.test(first),
  };
}

function ariaBoolean(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

function ariaBooleanOrMixed(value: string | null): boolean | "mixed" | null {
  return value === "mixed" ? "mixed" : ariaBoolean(value);
}

export function sanitizeSemanticDetail(raw: RawSemanticDetail, limits: Readonly<InteractiveBrowserLimits>): BrowserInspectResult["semantic"] {
  if (!raw || typeof raw !== "object") throw new Error("BrowserInspect could not safely read the semantic target.");
  const tag = semanticToken(raw.tag, 64, "other");
  const type = nullableSemanticToken(raw.type, 32);
  const editable = raw.editable;
  const suppressed = editable || tag === "input" || tag === "textarea" || tag === "select" || type === "password" || raw.textSuppressed;
  const name = boundedUntrustedText(raw.accessibleName, limits.maxInspectNameChars);
  const description = boundedUntrustedText(raw.accessibleDescription, limits.maxInspectDescriptionChars);
  const visible = boundedUntrustedText(suppressed ? "" : raw.visibleText, limits.maxInspectTextChars);
  return {
    role: raw.role ?? implicitSemanticRole(tag, type),
    tag,
    type,
    accessibleName: name.value,
    accessibleDescription: description.value,
    states: {
      checked: raw.checked,
      disabled: raw.disabled,
      expanded: raw.expanded,
      selected: raw.selected,
      focused: raw.focused,
      editable,
    },
    hrefOrigin: raw.href ? diagnosticPublicOrigin(raw.href) : null,
    visibleText: {
      text: suppressed ? "" : visible.value,
      returnedChars: suppressed ? 0 : visible.value.length,
      truncated: suppressed ? false : raw.visibleTextTruncated || visible.truncated,
      suppressed,
    },
  };
}

async function verifyComputedSemantic(locator: Locator, page: Page, computed: CapturedAriaSemantic): Promise<void> {
  if (!computed.role || !INSPECT_COMPUTED_ROLE_ALLOWLIST.has(computed.role)) return;
  const role = computed.role as Parameters<Page["getByRole"]>[0];
  const matches = await locator.and(page.getByRole(role, { name: computed.name, exact: true })).count();
  if (matches !== 1) {
    throw new Error("BrowserInspect semantic target changed since BrowserSnapshot; take a fresh BrowserSnapshot.");
  }
}

async function readComputedDescription(locator: Locator, maxChars: number): Promise<string> {
  // Playwright's fixed accessibility assertion runs in its isolated utility
  // world and returns the computed value without rewriting aria-ref identity.
  // Do not substitute to.have.property: that assertion uses the page world.
  const internal = locator as unknown as {
    _expect(expression: string, options: {
      expectedText: Array<{ regexSource: string }>;
      isNot: boolean;
      timeout: number;
    }): Promise<{ received?: unknown }>;
  };
  const result = await internal._expect("to.have.accessible.description", {
    expectedText: [{ regexSource: "(?!)" }],
    isNot: false,
    timeout: 1,
  });
  const received = result.received as { value?: unknown } | undefined;
  if (typeof received?.value !== "string") throw new Error("BrowserInspect computed description was unavailable.");
  // Bound only after computation, never before an exact-equality check.
  return received.value.slice(0, maxChars + 1);
}
