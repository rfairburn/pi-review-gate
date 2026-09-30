/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for the isolated page-side structure reads — target structures read
 * through the Playwright isolated selector-engine bridge (form facts, ref
 * targets, hit-tested point targets, document bases), plus the form-target
 * gates and the fixed native form dispatch helpers. Pages are only ever
 * read through Playwright's utility/isolated worlds; unsupported runtimes
 * fail closed with the fixed BrowserValidationError texts. No state and no
 * page-world evaluation lives here.
 */
import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";
import { BrowserValidationError, invalidRefError } from "./browser-errors.js";
import { settleBrowserReads } from "./browser-operations.js";
import type { BrowserFormOperation, BrowserTargetStructure } from "./browser-interaction-policy.js";

type IsolatedFormFacts = Pick<BrowserTargetStructure, "formAssociated" | "formAction" | "formMethod" | "autocomplete"> & {
  formHasCredentialField: boolean;
};

async function readIsolatedFormFacts(locator: Locator): Promise<IsolatedFormFacts> {
  // Match the owning document through the selector engine, not elementHandle:
  // handle creation can generate a preview in the hostile main world. This
  // internal bridge is required; unsupported Playwright runtimes fail closed.
  const internal = locator as unknown as {
    _selector?: string;
    _frame?: { _connection?: { toImpl?: (frame: unknown) => {
      selectors?: { callOnSelector?: (
        selector: string,
        options: { strict: boolean; mainWorld: boolean },
        callback: (args: { elements: Element[] }) => IsolatedFormFacts,
        arg: Record<string, never>,
      ) => Promise<{ result: IsolatedFormFacts } | null> };
    } } };
  };
  const frame = internal._frame;
  const selectors = frame?._connection?.toImpl?.(frame)?.selectors;
  if (!selectors?.callOnSelector || !internal._selector || !/^aria-ref=(?:f\d+)?e\d+$/.test(internal._selector)) {
    throw new BrowserValidationError("Browser interaction owning-form facts require the isolated selector engine.");
  }
  const resolved = await selectors.callOnSelector(internal._selector, { strict: true, mainWorld: false }, ({ elements }) => {
    // Structural credential-field selector: password-type inputs and explicit
    // current/new-password autocomplete tokens. HTML autocomplete field names
    // are ASCII case-insensitive (isCredentialFieldTarget lowercases them too),
    // so the selector matches them with the CSS `i` flag; `type` is already on
    // HTML's case-insensitive selector list, and the flag is harmless there.
    // No value is read. Defined inside this callback because only the function
    // body is serialized into the page's isolated world: module-scope constants
    // are not visible there.
    const credentialFieldSelector = 'input[type="password" i], [autocomplete~="current-password" i], [autocomplete~="new-password" i]';
    const element = elements[0];
    if (!element || elements.length !== 1) throw new Error("Form target unavailable.");
    const control = element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
    const form = control.form;
    const autocomplete = Element.prototype.getAttribute.call(control, "autocomplete")
      ?? (form ? Element.prototype.getAttribute.call(form, "autocomplete") : null);
    // Structural presence only: a hostile page cannot make this read any value,
    // and human-entered content is detected exactly like model-entered content.
    // Covers descendant credential controls plus form="id"-associated controls
    // (when the owning form has an id). Controls inside closed shadow roots
    // remain outside this structural proof; the policy layer additionally gates
    // activation presses on a proven credential control itself.
    let credentialField: Element | null = form ? form.querySelector(credentialFieldSelector) : null;
    if (!credentialField && form && form.id) {
      const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(form.id)
        : /^[a-zA-Z0-9_-]+$/.test(form.id) ? form.id : null;
      if (escapedId) {
        credentialField = document.querySelector(
          `input[type="password" i][form="${escapedId}"], [autocomplete~="current-password" i][form="${escapedId}"], [autocomplete~="new-password" i][form="${escapedId}"]`,
        );
      }
    }
    const formHasCredentialField = Boolean(credentialField);
    if (!form) return { formAssociated: false, formAction: null, formMethod: null, autocomplete, formHasCredentialField };
    // Native prototype getters also bypass DOM named-property shadowing, e.g.
    // an input named "action" or "method" on the owning form.
    const formAction = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "action")!.get!.call(form) as string;
    const formMethod = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "method")!.get!.call(form) as string;
    const submitterPrototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype
      : control instanceof HTMLButtonElement ? HTMLButtonElement.prototype : null;
    return {
      formAssociated: true,
      formAction: submitterPrototype && control.hasAttribute("formaction")
        ? Object.getOwnPropertyDescriptor(submitterPrototype, "formAction")!.get!.call(control) as string : formAction,
      formMethod: submitterPrototype && control.hasAttribute("formmethod")
        ? Object.getOwnPropertyDescriptor(submitterPrototype, "formMethod")!.get!.call(control) as string : formMethod,
      autocomplete,
      formHasCredentialField,
    };
  }, {});
  if (!resolved?.result || typeof resolved.result.formAssociated !== "boolean"
    || typeof resolved.result.formHasCredentialField !== "boolean") {
    throw new BrowserValidationError("Browser interaction owning-form facts were unavailable.");
  }
  return resolved.result;
}

export async function readTargetStructure(
  locator: Locator,
  page: Page,
  options?: { includeCredentialTargets?: boolean; includeFileInputs?: boolean },
): Promise<BrowserTargetStructure> {
  // Only public Playwright utility-world reads. Even apparently innocuous
  // locator.evaluate getters execute hostile main-world code before approval.
  const names = ["type", "role", "href", "target", "download", "form",
    "aria-haspopup", "autocomplete", "readonly", "multiple", "id", "name"];
  const attributes = await settleBrowserReads(names.map(name => locator.getAttribute(name)));
  const attr = (name: string) => attributes[names.indexOf(name)] ?? null;
  const token = (name: string) => attr(name)?.trim().toLocaleLowerCase("en-US") ?? null;
  const matches = async (selector: string) => await locator.and(page.locator(selector)).count() === 1;
  const tagName = await identifySemanticTag(locator, page);
  const inputType = tagName === "input" || tagName === "button"
    ? token("type") || (tagName === "button" ? "submit" : "text") : null;
  if (inputType === "file" && !options?.includeFileInputs) {
    throw new Error("not_started: file controls require the dedicated BrowserUpload tool; bounded click and form actions do not dispatch them.");
  }
  // Click/hover never enter or submit values, so password targets stay hard-
  // denied there. Form operations read the structure and let the issue #27
  // credential capability gates decide authorization with precise denials.
  if (inputType === "password" && !options?.includeCredentialTargets) {
    throw new Error("not_started: password controls are not supported by bounded browser click or hover actions.");
  }
  const form = ["input", "button", "select", "textarea"].includes(tagName)
    ? await readIsolatedFormFacts(locator)
    : { formAssociated: false, formAction: null, formMethod: null, autocomplete: token("autocomplete"), formHasCredentialField: false };
  // Preserve native relative/fragment semantics without entering the page realm.
  // The owning document's isolated base read accounts for CSP and inherited bases.
  const rawHref = attr("href");
  const href = (tagName === "a" || tagName === "area") && rawHref !== null
    ? new URL(rawHref, await ownerDocumentBaseUrl(locator)).href : null;
  const structure: BrowserTargetStructure = {
    tagName, inputType, role: token("role"), href, target: token("target"),
    download: attr("download") !== null,
    formAssociated: form.formAssociated,
    formAction: form.formAction, formMethod: form.formMethod,
    formHasCredentialField: form.formHasCredentialField,
    ariaHasPopup: token("aria-haspopup"),
    contentEditable: await matches('[contenteditable]:not([contenteditable="false"]), [contenteditable]:not([contenteditable="false"]) *'),
    disabled: await locator.isDisabled(),
    inlineEventHandler: await matches("[onclick], [onmousedown], [onmouseup], [onpointerdown], [onpointerup]"),
    summaryForDetails: tagName === "summary" && await matches("details > summary"),
    autocomplete: form.autocomplete?.trim().toLocaleLowerCase("en-US") ?? null, readOnly: attr("readonly") !== null,
    multiple: attr("multiple") !== null,
    // Absence of direct/delegated handlers is not provable. Form events always
    // route through the existing authorization/permit/revalidation branch.
    explicitChangeHandler: false, explicitSubmitHandler: false, pageControlledEventsAbsent: false,
    domPath: createHash("sha256").update(JSON.stringify([tagName, attr("id"), attr("name"), attr("form"), attr("href")])).digest("hex"),
  };
  if (!isBrowserTargetStructure(structure) || !boundedTargetStructure(structure)) {
    throw new Error("Browser interaction target structure could not be safely inspected within policy bounds.");
  }
  return structure;
}

function isBrowserTargetStructure(value: unknown): value is BrowserTargetStructure {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return typeof target.tagName === "string"
    && (typeof target.role === "string" || target.role === null)
    && (typeof target.href === "string" || target.href === null)
    && (typeof target.target === "string" || target.target === null)
    && typeof target.download === "boolean"
    && (typeof target.inputType === "string" || target.inputType === null)
    && typeof target.formAssociated === "boolean"
    && (typeof target.formAction === "string" || target.formAction === null)
    && (typeof target.formMethod === "string" || target.formMethod === null)
    && (typeof target.ariaHasPopup === "string" || target.ariaHasPopup === null)
    && typeof target.contentEditable === "boolean"
    && typeof target.disabled === "boolean"
    && typeof target.inlineEventHandler === "boolean"
    && typeof target.summaryForDetails === "boolean"
    && (target.autocomplete === undefined || typeof target.autocomplete === "string" || target.autocomplete === null)
    && (target.readOnly === undefined || typeof target.readOnly === "boolean")
    && (target.multiple === undefined || typeof target.multiple === "boolean")
    && (target.explicitChangeHandler === undefined || typeof target.explicitChangeHandler === "boolean")
    && (target.explicitSubmitHandler === undefined || typeof target.explicitSubmitHandler === "boolean")
    && (target.pageControlledEventsAbsent === undefined || typeof target.pageControlledEventsAbsent === "boolean")
    && (target.formHasCredentialField === undefined || typeof target.formHasCredentialField === "boolean")
    && typeof target.domPath === "string";
}

function boundedTargetStructure(target: BrowserTargetStructure): boolean {
  return target.tagName.length <= 128
    && (target.role === null || target.role.length <= 64)
    && (target.href === null || target.href.length <= 4_096)
    && (target.target === null || target.target.length <= 64)
    && (target.inputType === null || target.inputType.length <= 32)
    && (target.formAction === null || target.formAction.length <= 4_096)
    && (target.formMethod === null || target.formMethod.length <= 16)
    && (target.ariaHasPopup === null || target.ariaHasPopup.length <= 32)
    && (target.autocomplete === undefined || target.autocomplete === null || target.autocomplete.length <= 128)
    && target.domPath.length <= 512;
}

/**
 * Raw structural facts of one hit-tested point target, produced inside the
 * page's Playwright utility world (issue #141). domPathParts carries the exact
 * raw attribute tuple the ref-mode domPath digests; the digest is computed in
 * the manager so no hashing exists inside the page.
 */
interface IsolatedPointFacts {
  tagName: string;
  domPathParts: readonly (string | null)[];
  role: string | null;
  href: string | null;
  target: string | null;
  download: boolean;
  inputType: string | null;
  formAssociated: boolean;
  formAction: string | null;
  formMethod: string | null;
  ariaHasPopup: string | null;
  autocomplete: string | null;
  contentEditable: boolean;
  disabled: boolean;
  inlineEventHandler: boolean;
  summaryForDetails: boolean;
  formHasCredentialField: boolean;
}

/** Fail-closed validation of the utility-world facts before any policy use. */
function isIsolatedPointFacts(value: unknown): value is IsolatedPointFacts {
  if (typeof value !== "object" || value === null) return false;
  const facts = value as Record<string, unknown>;
  const isBoundedString = (v: unknown): v is string => typeof v === "string" && v.length <= 8_192;
  const nullableString = (v: unknown): boolean => v === null || isBoundedString(v);
  return typeof facts.tagName === "string" && facts.tagName.length <= 128
    && Array.isArray(facts.domPathParts) && facts.domPathParts.length === 5
    && facts.domPathParts.every((part) => part === null || isBoundedString(part))
    && nullableString(facts.role) && nullableString(facts.href) && nullableString(facts.target)
    && nullableString(facts.inputType) && nullableString(facts.formAction) && nullableString(facts.formMethod)
    && nullableString(facts.ariaHasPopup) && nullableString(facts.autocomplete)
    && typeof facts.download === "boolean"
    && typeof facts.formAssociated === "boolean"
    && typeof facts.contentEditable === "boolean" && typeof facts.disabled === "boolean"
    && typeof facts.inlineEventHandler === "boolean" && typeof facts.summaryForDetails === "boolean"
    && typeof facts.formHasCredentialField === "boolean";
}

export async function readPointTargetStructure(page: Page, x: number, y: number): Promise<BrowserTargetStructure> {
  // The exact point is hit-tested in the page's Playwright utility world via
  // the same isolated selector-engine bridge the owning-form reader requires.
  // The page's main JavaScript world is never evaluated; unsupported runtimes
  // fail closed.
  const frame = page.mainFrame() as unknown as {
    _connection?: { toImpl?: (frame: unknown) => {
      selectors?: { callOnSelector?: (
        selector: string,
        options: { strict: boolean; mainWorld: boolean },
        callback: (args: { elements: Element[] }, point: { x: number; y: number }) => IsolatedPointFacts,
        arg: { x: number; y: number },
      ) => Promise<{ result: IsolatedPointFacts } | null> };
    } };
  };
  const selectors = frame._connection?.toImpl?.(frame)?.selectors;
  if (!selectors?.callOnSelector) {
    throw new BrowserValidationError("not_started: BrowserClick coordinates require the isolated selector engine; no coordinate dispatch is available.");
  }
  let resolved: { result: IsolatedPointFacts } | null;
  try {
    resolved = await selectors.callOnSelector("html", { strict: true, mainWorld: false }, (args, point) => {
      // Serialized into the utility world: only this body runs there, and the
      // shared DOM wrappers of that isolated world cannot be tampered with by
      // page script. Native prototype getters only.
      const root = args?.elements?.[0];
      if (!root || args.elements.length !== 1 || root.tagName !== "HTML") {
        throw new Error("utility world document unavailable");
      }
      // Descend through open shadow roots so the structural facts — and the
      // hard password/file/credential gates below — apply to the element that
      // will actually receive the click, not to its shadow host (mirrors
      // Playwright's own deep element-from-point). Closed shadow roots are
      // not descendable from script; the host is reported there, matching the
      // owning-form reader's closed-root limitation.
      const deepElementFromPoint = (px: number, py: number): Element | null => {
        let candidate = document.elementFromPoint(px, py);
        while (candidate && candidate.shadowRoot) {
          const inner = candidate.shadowRoot.elementFromPoint(px, py);
          if (!inner || inner === candidate) break;
          candidate = inner;
        }
        return candidate;
      };
      const element = deepElementFromPoint(point.x, point.y);
      if (!element) throw new Error("no element at the requested point");
      const nativeGetAttribute = Element.prototype.getAttribute;
      const attr = (name: string): string | null => {
        const value = nativeGetAttribute.call(element, name);
        return value === null ? null : String(value);
      };
      const token = (name: string): string | null => attr(name)?.trim().toLocaleLowerCase("en-US") ?? null;
      const tagName = element.tagName.toLocaleLowerCase("en-US");
      // Cross-frame coordinate dispatch would leave the structural read unable
      // to establish the inner document's gates; fail closed there.
      if (tagName === "iframe" || tagName === "frame" || tagName === "object" || tagName === "embed") {
        throw new Error("point target is an embedded frame; bounded coordinate clicks do not dispatch into frames");
      }
      const control = element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
      const form = control.form ?? null;
      const formFacts = ["input", "button", "select", "textarea"].includes(tagName) && form ? (() => {
        const submitterPrototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype
          : control instanceof HTMLButtonElement ? HTMLButtonElement.prototype : null;
        return {
          formAssociated: true,
          formAction: submitterPrototype && control.hasAttribute("formaction")
            ? Object.getOwnPropertyDescriptor(submitterPrototype, "formAction")!.get!.call(control) as string : Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "action")!.get!.call(form) as string,
          formMethod: submitterPrototype && control.hasAttribute("formmethod")
            ? Object.getOwnPropertyDescriptor(submitterPrototype, "formMethod")!.get!.call(control) as string : Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "method")!.get!.call(form) as string,
        };
      })() : { formAssociated: false, formAction: null, formMethod: null };
      // Structural credential-field presence only: no value is ever read.
      // Same fixed selector and form="id" coverage as the owning-form reader.
      const credentialFieldSelector = 'input[type="password" i], [autocomplete~="current-password" i], [autocomplete~="new-password" i]';
      let credentialField = form ? form.querySelector(credentialFieldSelector) : null;
      if (!credentialField && form && form.id) {
        const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(form.id)
          : /^[a-zA-Z0-9_-]+$/.test(form.id) ? form.id : null;
        if (escapedId) {
          credentialField = document.querySelector(
            `input[type="password" i][form="${escapedId}"], [autocomplete~="current-password" i][form="${escapedId}"], [autocomplete~="new-password" i][form="${escapedId}"]`,
          );
        }
      }
      const contentEditable = (() => {
        let candidate: Element | null = element;
        while (candidate) {
          const value = nativeGetAttribute.call(candidate, "contenteditable");
          if (value !== null && value.toLocaleLowerCase("en-US") !== "false") return true;
          candidate = candidate.parentElement;
        }
        return false;
      })();
      const inputType = tagName === "input" || tagName === "button"
        ? token("type") || (tagName === "button" ? "submit" : "text")
        : null;
      const rawHref = attr("href");
      const href = (tagName === "a" || tagName === "area") && rawHref !== null
        ? new URL(rawHref, document.baseURI).href : null;
      return {
        tagName,
        domPathParts: [tagName, attr("id"), attr("name"), attr("form"), rawHref],
        role: token("role"),
        href,
        target: token("target"),
        download: attr("download") !== null,
        inputType,
        formAssociated: formFacts.formAssociated,
        formAction: formFacts.formAction,
        formMethod: formFacts.formMethod,
        ariaHasPopup: token("aria-haspopup"),
        autocomplete: (attr("autocomplete") ?? (form ? nativeGetAttribute.call(form, "autocomplete") : null))?.trim().toLocaleLowerCase("en-US") ?? null,
        contentEditable,
        disabled: element.matches(":disabled"),
        inlineEventHandler: ["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup"].some((name) => attr(name) !== null),
        summaryForDetails: tagName === "summary" && element.matches("details > summary"),
        formHasCredentialField: Boolean(credentialField),
      };
    }, { x, y });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrowserValidationError(`not_started: BrowserClick coordinate target could not be structurally inspected: ${message}.`);
  }
  if (!resolved?.result || !isIsolatedPointFacts(resolved.result)) {
    throw new BrowserValidationError("not_started: BrowserClick coordinate target structure was unavailable.");
  }
  const facts = resolved.result;
  const structure: BrowserTargetStructure = {
    tagName: facts.tagName,
    role: facts.role,
    href: facts.href,
    target: facts.target,
    download: facts.download,
    inputType: facts.inputType,
    formAssociated: facts.formAssociated,
    formAction: facts.formAction,
    formMethod: facts.formMethod,
    ariaHasPopup: facts.ariaHasPopup,
    contentEditable: facts.contentEditable,
    disabled: facts.disabled,
    inlineEventHandler: facts.inlineEventHandler,
    summaryForDetails: facts.summaryForDetails,
    autocomplete: facts.autocomplete,
    formHasCredentialField: facts.formHasCredentialField,
    explicitChangeHandler: false,
    explicitSubmitHandler: false,
    pageControlledEventsAbsent: false,
    domPath: createHash("sha256").update(JSON.stringify([facts.domPathParts[0], facts.domPathParts[1], facts.domPathParts[2], facts.domPathParts[3], facts.domPathParts[4]])).digest("hex"),
  };
  if (!isBrowserTargetStructure(structure) || !boundedTargetStructure(structure)) {
    throw new Error("BrowserClick coordinate target structure could not be safely inspected within policy bounds.");
  }
  return structure;
}

/**
 * Issue #141: hard credential/file gates for the exact hit-tested point
 * target, mirroring the ref-click preflight texts. Coordinate clicks never
 * bypass these gates merely because no ref was used.
 */
export function assertCoordinatePointGate(structure: BrowserTargetStructure): void {
  if (structure.inputType === "file") {
    throw new Error("not_started: file controls require the dedicated BrowserUpload tool; bounded click and form actions do not dispatch them.");
  }
  if (structure.inputType === "password") {
    throw new Error("not_started: password controls are not supported by bounded browser click or hover actions.");
  }
}

export function assertUploadTarget(target: BrowserTargetStructure, fileCount: number): void {
  if (target.inputType !== "file") throw new Error("not_started: the semantic target is not a file input control.");
  if (target.disabled) throw new Error("not_started: the browser file input target is disabled.");
  // Playwright enforces this inside setInputFiles, after approval and with
  // the operation already claimed as started; reject it up front instead so
  // an impossible upload never consumes a permit or tears down the session.
  if (fileCount > 1 && target.multiple !== true) {
    throw new Error("not_started: the browser file input does not accept multiple files; request one file or choose a multiple-file input.");
  }
}

export function assertSuitableFormTarget(target: BrowserTargetStructure, operation: BrowserFormOperation): void {
  if (target.inputType === "file") {
    throw new Error("File controls require the dedicated BrowserUpload tool; bounded form actions do not dispatch them.");
  }
  if (target.disabled || target.readOnly) throw new Error("The browser form target is not editable.");
  const role = target.role;
  // Password inputs are structurally suitable editable text controls; whether
  // the model may act on them is decided by the issue #27 credential entry
  // gate, which fails with a precise denial before any approval prompt.
  const textInput = target.tagName === "input"
    && ["text", "search", "email", "url", "tel", "number", "password"].includes(target.inputType ?? "")
    && (role === null || role === "textbox" || role === "searchbox");
  const textTarget = textInput
    || (target.tagName === "textarea" && (role === null || role === "textbox"))
    || (target.contentEditable && (role === null || role === "textbox"));
  if (operation === "fill" && !textTarget) {
    throw new Error("The semantic target is not a supported editable text control.");
  }
  const sequentialTextInput = textInput
    && ["text", "search", "url", "tel", "password"].includes(target.inputType ?? "");
  const sequentialTextTarget = sequentialTextInput
    || (target.tagName === "textarea" && (role === null || role === "textbox"))
    || (target.contentEditable && (role === null || role === "textbox"));
  if (operation === "type" && !sequentialTextTarget) {
    throw new Error("The semantic target cannot safely establish bounded append positioning.");
  }
  const selectTarget = target.tagName === "select"
    && (role === null || role === "listbox" || role === "combobox");
  if (operation === "select" && !selectTarget) {
    throw new Error("The semantic target is not a supported native select control.");
  }
  const pressTarget = textTarget
    || selectTarget
    || (target.tagName === "button" && (role === null || role === "button"))
    || (target.tagName === "a" && target.href !== null && (role === null || role === "link" || role === "button"))
    || (target.summaryForDetails && (role === null || role === "button"));
  if (operation === "press" && !pressTarget) {
    throw new Error("The semantic target does not support bounded key interaction.");
  }
}

export async function positionAppendCaret(locator: Locator): Promise<void> {
  const positioned = await locator.evaluate((element, expectedOperation) => {
    if (expectedOperation !== "append") return false;
    const html = element as HTMLElement;
    html.focus({ preventScroll: true });
    if (html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) {
      const end = html.value.length;
      try { html.setSelectionRange(end, end); }
      catch { return false; }
      return html.selectionStart === end && html.selectionEnd === end;
    }
    if (html.isContentEditable) {
      const selection = html.ownerDocument.getSelection();
      if (!selection) return false;
      const range = html.ownerDocument.createRange();
      range.selectNodeContents(html);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  }, "append");
  if (!positioned) throw new Error("BrowserType could not establish a bounded append position.");
}

export async function resolveExactSelectOptions(locator: Locator, values: readonly string[]): Promise<{ kinds: Array<"value" | "label">; labels: string[] }> {
  const options = locator.locator("option");
  const count = await options.count();
  if (count > 512 || (values.length > 1 && await locator.getAttribute("multiple") === null)) {
    throw new Error("The requested option set exceeds bounded native selection limits.");
  }
  const facts = await settleBrowserReads(Array.from({ length: count }, async (_, index) => {
    const option = options.nth(index);
    const [value, label, text] = await settleBrowserReads([option.getAttribute("value"), option.getAttribute("label"), option.textContent()]);
    const normalizedText = (text ?? "").replace(/[\t\n\f\r ]+/g, " ").trim();
    return { value: value ?? normalizedText, label: label || normalizedText, text: text ?? "" };
  }));
  const kinds: Array<"value" | "label"> = [];
  const labels: string[] = [];
  const indexes = new Set<number>();
  for (const value of values) {
    const matches = facts.map((fact, index) => ({ fact, index })).filter(({ fact }) => fact.value === value || fact.label === value);
    if (matches.length !== 1 || indexes.has(matches[0]!.index)) {
      throw new Error("The requested exact option set was unavailable, ambiguous, or incompatible with this control.");
    }
    const { fact, index } = matches[0]!;
    indexes.add(index);
    kinds.push(fact.value === value ? "value" : "label");
    labels.push(fact.label, fact.text, fact.value);
  }
  return { kinds, labels };
}

export async function assertControlledTopNavigation(locator: Locator, _page: Page): Promise<void> {
  const facts = await readIsolatedNavigationFacts(locator);
  if (!facts.topLevel) {
    throw new Error("BrowserClick not_started: controlled navigation from a child frame is unsupported.");
  }
  if (facts.target && facts.target.toLowerCase() !== "_self") {
    throw new Error("BrowserClick not_started: controlled navigation requires the current frame as its effective target.");
  }
}

const INSPECT_TAG_ALLOWLIST = [
  "a", "area", "button", "input", "textarea", "select", "option", "img", "summary", "details",
  "form", "fieldset", "legend", "label", "nav", "main", "header", "footer", "section", "article",
  "ul", "ol", "li", "table", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div", "span", "svg",
] as const;

export async function identifySemanticTag(locator: Locator, page: Page): Promise<string> {
  const matches = await settleBrowserReads(INSPECT_TAG_ALLOWLIST.map(async (tag) =>
    (await locator.and(page.locator(tag)).count()) === 1));
  const index = matches.indexOf(true);
  return index < 0 ? "other" : INSPECT_TAG_ALLOWLIST[index]!;
}

export async function ownerDocumentBaseUrl(locator: Locator): Promise<string> {
  return (await readIsolatedNavigationFacts(locator)).baseUrl;
}

export type IsolatedNavigationFacts = { baseUrl: string; topLevel: boolean; target: string | null };

export async function readIsolatedNavigationFacts(locator: Locator): Promise<IsolatedNavigationFacts> {
  // Use the in-process Playwright implementation's isolated selector evaluator.
  // Reading markup cannot account for CSP or frozen inherited document bases.
  // Do not use locator.evaluate / to.have.property, or acquire a main-world
  // ElementHandle: those can enter the page realm (including handle previews).
  const internal = locator as unknown as {
    _selector: string;
    _frame: { _connection?: { toImpl?(frame: unknown): {
      selectors?: { callOnSelector?(
        selector: string,
        options: { strict: true; mainWorld: false },
        read: (target: { elements: Element[] }) => IsolatedNavigationFacts | null,
        arg: undefined,
      ): Promise<{ result: unknown } | null> };
    } } };
  };
  // Only our generation-scoped aria-ref locator is accepted, never a caller
  // selector or a custom selector engine. Built-in aria-ref runs in utility.
  if (!/^aria-ref=(?:f\d+)?e\d+$/.test(internal._selector)) throw invalidRefError();
  const implementation = internal._frame?._connection?.toImpl?.(internal._frame);
  if (!implementation?.selectors?.callOnSelector) {
    throw new Error("BrowserInspect isolated document base reader is unavailable.");
  }
  const observed = await implementation.selectors.callOnSelector(
    internal._selector,
    { strict: true, mainWorld: false },
    ({ elements }) => {
      const element = elements[0];
      if (elements.length !== 1 || !element?.isConnected) return null;
      const document = element.ownerDocument;
      const view = document.defaultView;
      return {
        baseUrl: document.baseURI,
        topLevel: view !== null && view === view.top,
        target: element.getAttribute("target") ?? document.querySelector("base[target]")?.getAttribute("target") ?? null,
      };
    },
    undefined,
  );
  const facts = observed?.result as Partial<IsolatedNavigationFacts> | null;
  if (!facts || typeof facts.baseUrl !== "string" || typeof facts.topLevel !== "boolean"
    || (facts.target !== null && typeof facts.target !== "string")) throw invalidRefError();
  return facts as IsolatedNavigationFacts;
}
