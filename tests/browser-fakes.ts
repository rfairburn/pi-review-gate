// Shared Playwright fakes for interactive-browser tests. Kept free of
// test() registrations so multiple suites can import them without side effects.
import assert from "node:assert/strict";
import * as net from "node:net";
import { EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page } from "playwright";
import { normalizeConfig } from "../src/config";
import type { BrowserConfirmationPermits, BrowserTargetStructure } from "../src/web/browser-interaction-policy";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export class FakePage extends EventEmitter {
  private currentUrl = "about:blank";
  private closed = false;
  private visited: string[] = [];
  private visitedIndex = -1;
  readonly frame = {
    url: () => this.url(),
    locator: (_selector: string) => ({ first: () => ({ count: async () => 0 }) }),
    parentFrame: () => null,
    // Issue #141: the point-read bridge hangs off the main frame's selector
    // engine, mirroring how real Playwright exposes the utility world.
    _connection: { toImpl: () => ({ selectors: {
      callOnSelector: async (
        selector: string,
        options: { strict: boolean; mainWorld: boolean },
        _callback: unknown,
        point: { x: number; y: number },
      ) => {
        assert.equal(selector, "html");
        assert.deepEqual(options, { strict: true, mainWorld: false });
        assert.ok(point && Number.isFinite(point.x) && Number.isFinite(point.y));
        if (this.pointFacts instanceof Error) throw this.pointFacts;
        return { result: this.pointFacts ?? null };
      },
    } }) },
  };
  evaluateCalls = 0;
  hoverCalls = 0;
  clickCalls = 0;
  fillCalls: string[] = [];
  typeCalls: Array<{ text: string; delay: number }> = [];
  selectCalls: Array<Array<{ value?: string; label?: string }>> = [];
  pressCalls: string[] = [];
  setInputFilesCalls: Array<{ paths: string[] }> = [];
  onSetInputFiles?: (paths: string[]) => void | Promise<void>;
  onClick?: () => void | Promise<void>;
  onStructureRead?: () => void;
  /** Issue #141 viewport plumbing: the fake starts at the bounded default and
   * records every setViewportSize call. */
  viewportCalls: Array<{ width: number; height: number }> = [];
  private currentViewport = { width: 1280, height: 720 };
  setViewportSizeFailure?: Error;
  /** Issue #141 coordinate clicks: recorded page.mouse.click dispatches. */
  mouseClicks: Array<{ x: number; y: number; button: string }> = [];
  onMouseClick?: (point: { x: number; y: number; button: string }) => void | Promise<void>;
  /** Issue #141 point-read bridge result: raw utility-world facts (domPath is
   * computed by the manager) or an Error to fail the hit test. The default
   * matches a semantically unknown element at the point (e.g. a canvas). */
  pointFacts: Record<string, unknown> | Error = {
    tagName: "canvas",
    domPathParts: ["canvas", null, null, null, null],
    role: null, href: null, target: null, download: false, inputType: null,
    formAssociated: false, formAction: null, formMethod: null, ariaHasPopup: null,
    autocomplete: null, contentEditable: false, disabled: false,
    inlineEventHandler: false, summaryForDetails: false, formHasCredentialField: false,
  };
  targetStructure: BrowserTargetStructure = {
    tagName: "a", role: "link", href: "https://example.com/next", target: null,
    download: false, inputType: null, formAssociated: false, formAction: null,
    formMethod: null, formHasCredentialField: false, ariaHasPopup: null, contentEditable: false, disabled: false,
    inlineEventHandler: false, summaryForDetails: false,
    domPath: "html:nth-of-type(1)> body:nth-of-type(1)> a:nth-of-type(1)",
  };
  readonly visibleTextMatches = new Map<string, number>();
  inspectDelayMs = 0;

  mainFrame() { return this.frame; }
  url() { return this.currentUrl; }
  isClosed() { return this.closed; }
  async routeWebSocket() {}
  async title() { return "Untrusted fixture title"; }
  viewportSize() { return { ...this.currentViewport }; }
  async setViewportSize(viewport: { width: number; height: number }) {
    this.viewportCalls.push({ ...viewport });
    if (this.setViewportSizeFailure) throw this.setViewportSizeFailure;
    this.currentViewport = { ...viewport };
  }
  readonly mouse = {
    click: async (x: number, y: number, options?: { button?: string }) => {
      const point = { x, y, button: options?.button ?? "left" };
      this.mouseClicks.push(point);
      await this.onMouseClick?.(point);
    },
  };
  async ariaSnapshot() { return '- heading "Fixture" [level=1]\n- link "Next" [ref=e7]\n'; }
  async screenshot(_options?: Record<string, any>) { return ONE_PIXEL_PNG; }
  /** Issue #27: fixed-protocol page-code hook for manager tests (e.g. the
   * clipboard scripts). Absent by default so existing evaluate behavior —
   * counting the call and returning undefined — is unchanged. */
  onEvaluate?: (source: unknown, arg?: unknown) => unknown;
  async evaluate(source?: unknown, ...args: unknown[]) {
    this.evaluateCalls += 1;
    if (this.onEvaluate) return this.onEvaluate(source, args[0]);
    return undefined;
  }
  async bringToFront() {}
  getByRole(role: string, options: { name?: string } = {}) {
    return { fixtureRole: role, fixtureName: options.name ?? "" };
  }
  getByText(text: string) {
    return {
      filter: ({ visible }: { visible: boolean }) => {
        assert.equal(visible, true);
        return {
          first: () => ({
            waitFor: async ({ state }: { state: string }) => {
              const visibleCount = this.visibleTextMatches.has(text)
                ? this.visibleTextMatches.get(text)!
                : text === "Missing" ? 0 : 1;
              if (state === "attached" && visibleCount === 0) throw new Error("no visible text match");
              if (state === "hidden" && visibleCount > 0) throw new Error("visible text match remains");
            },
          }),
        };
      },
    };
  }
  async waitForURL(predicate: (url: URL) => boolean) {
    if (!predicate(new URL(this.currentUrl))) throw new Error("fixture URL condition not satisfied");
  }
  async waitForNavigation() {}
  async waitForTimeout(durationMs: number) { await new Promise<void>((resolve) => setTimeout(resolve, durationMs)); }
  locator(selector: string): any {
    if (selector !== "aria-ref=e7") return { fixtureTag: selector };
    const page = this;
    return {
      _selector: selector,
      _frame: { _connection: { toImpl: () => ({ selectors: {
        callOnSelector: async (ownedSelector: string, options: { strict: boolean; mainWorld: boolean }) => {
          assert.equal(ownedSelector, "aria-ref=e7");
          assert.deepEqual(options, { strict: true, mainWorld: false });
          return { result: {
            formAssociated: page.targetStructure.formAssociated, formAction: page.targetStructure.formAction,
            formMethod: page.targetStructure.formMethod, autocomplete: page.targetStructure.autocomplete ?? null,
            baseUrl: page.url(), topLevel: true, target: null,
            formHasCredentialField: page.targetStructure.formHasCredentialField ?? false,
          } };
        },
      } }) } },
      elementHandle: async () => { throw new Error("Preflight must not create page-world element previews."); },
      _expect: async () => ({ received: { value: "Fixture description" } }),
      scrollIntoViewIfNeeded: async () => undefined,
      waitFor: async () => undefined,
      getAttribute: async (name: string) => name === "type"
        ? (page.onStructureRead?.(), page.targetStructure.inputType)
        : name === "role" ? page.targetStructure.role
          : name === "href" ? page.targetStructure.href
            : name === "aria-description" ? "Fixture description"
              : name === "id" ? page.targetStructure.domPath
                : name === "multiple" ? (page.targetStructure.multiple ? "" : null)
                  : name === "autocomplete" ? page.targetStructure.autocomplete ?? null
                    : name === "readonly" ? (page.targetStructure.readOnly ? "" : null) : null,
      locator: (selector: string) => {
        if (selector === "xpath=ancestor-or-self::*[@contenteditable][1]") return { count: async () => 0 };
        assert.equal(selector, "option");
        const labels = ["Private A", "Private B", "private-approval-value", "private"];
        return { count: async () => labels.length, nth: (index: number) => ({
          getAttribute: async (name: string) => name === "value" ? labels[index] : null,
          textContent: async () => labels[index],
        }) };
      },
      ariaSnapshot: async () => {
        if (page.inspectDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, page.inspectDelayMs));
        const role = page.targetStructure.role ?? (page.targetStructure.tagName === "input" ? "textbox" : "generic");
        return `- ${role} "Next"${page.targetStructure.disabled ? " [disabled]" : ""} [ref=e7]`;
      },
      isDisabled: async () => page.targetStructure.disabled,
      isEditable: async () => !page.targetStructure.disabled && !page.targetStructure.readOnly
        && (page.targetStructure.contentEditable || ["input", "textarea", "select"].includes(page.targetStructure.tagName)),
      isChecked: async () => { throw new Error("not checkable"); },
      innerText: async () => {
        if (page.inspectDelayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, page.inspectDelayMs));
        return "Visible fixture text";
      },
      and: (other: { fixtureTag?: string; fixtureRole?: string; fixtureName?: string }) => ({
        count: async () => {
          if (other.fixtureRole) {
            const role = page.targetStructure.role ?? (page.targetStructure.tagName === "input" ? "textbox" : "generic");
            return other.fixtureRole === role && other.fixtureName === "Next" ? 1 : 0;
          }
          const selector = other.fixtureTag;
          if (selector === "details > summary") return page.targetStructure.summaryForDetails ? 1 : 0;
          if (selector === "form input, form button, form select, form textarea") return page.targetStructure.formAssociated ? 1 : 0;
          if (selector?.startsWith("[contenteditable]")) return page.targetStructure.contentEditable ? 1 : 0;
          if (selector?.startsWith("[onclick]")) return page.targetStructure.inlineEventHandler ? 1 : 0;
          return selector === page.targetStructure.tagName ? 1 : 0;
        },
      }),
      evaluate: async (_callback: unknown, ...args: unknown[]) => {
        if (Array.isArray(args[0])) return args[0].map(() => "value");
        if (args[0] === "append") return true;
        if (args.length > 0) return undefined;
        page.onStructureRead?.();
        return { ...page.targetStructure };
      },
      hover: async () => { this.hoverCalls += 1; },
      click: async () => { this.clickCalls += 1; await this.onClick?.(); },
      fill: async (value: string) => { this.fillCalls.push(value); },
      pressSequentially: async (text: string, options: { delay?: number }) => {
        this.typeCalls.push({ text, delay: options.delay ?? 0 });
      },
      selectOption: async (options: Array<{ value?: string; label?: string }>) => {
        this.selectCalls.push(options);
      },
      press: async (key: string) => { this.pressCalls.push(key); },
      setInputFiles: async (paths: string[]) => {
        page.setInputFilesCalls.push({ paths: [...paths] });
        await page.onSetInputFiles?.([...paths]);
      },
      boundingBox: async () => ({ x: 1, y: 2, width: 50, height: 20 }),
      screenshot: async () => { throw new Error("element screenshot must use a prevalidated page clip"); },
    };
  }
  private commit(url: string, addHistory: boolean) {
    const request = {
      isNavigationRequest: () => true,
      frame: () => this.frame,
      redirectedFrom: () => null,
    };
    this.emit("request", request);
    this.currentUrl = url;
    if (addHistory) {
      this.visited.splice(this.visitedIndex + 1);
      this.visited.push(url);
      this.visitedIndex = this.visited.length - 1;
    }
    const response = { status: () => 200, request: () => request };
    this.emit("response", response);
    this.emit("framenavigated", this.frame);
    return response;
  }
  navigationHistory() {
    return { currentIndex: this.visitedIndex, entries: this.visited.map((url, index) => ({ id: index + 1, url })) };
  }
  async navigateToHistoryEntry(id: number) {
    if (id === this.visitedIndex) await this.goBack();
    else if (id === this.visitedIndex + 2) await this.goForward();
    else throw new Error("unexpected fixture history target");
  }
  async goto(url: string) { return this.commit(url, true); }
  async goBack() {
    if (this.visitedIndex <= 0) return null;
    this.visitedIndex -= 1;
    return this.commit(this.visited[this.visitedIndex]!, false);
  }
  async goForward() {
    if (this.visitedIndex >= this.visited.length - 1) return null;
    this.visitedIndex += 1;
    return this.commit(this.visited[this.visitedIndex]!, false);
  }
  async reload() { return this.commit(this.currentUrl, false); }
  async waitForLoadState() {}
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

export class FakeCdpSession {
  readonly sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private readonly handlers = new Map<string, Array<(payload: any) => void>>();
  detached = false;
  constructor(private readonly page: FakePage) {}
  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push({ method, params });
    if (method === "Page.getNavigationHistory") return this.page.navigationHistory();
    if (method === "Page.navigateToHistoryEntry") return this.page.navigateToHistoryEntry((params as { entryId: number }).entryId);
    if (method === "Page.enable" || method === "Runtime.enable" || method === "Page.addScriptToEvaluateOnNewDocument") return {};
    throw new Error(`Unexpected internal protocol method ${method}`);
  }
  on(event: string, handler: (payload: any) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emitConsoleCall(type: string, value: unknown) {
    for (const handler of this.handlers.get("Runtime.consoleAPICalled") ?? []) {
      handler({ type, args: [{ type: "string", value }] });
    }
  }
  async detach() { this.detached = true; }
}
export class FakeContext extends EventEmitter {
  readonly page = new FakePage();
  /** Real Playwright exposes context.pages() as a method; visibility capture relies on it. */
  private readonly pageList: FakePage[] = [this.page];
  pages(): FakePage[] { return this.pageList; }
  private created = 0;
  configureNextPage?: (page: FakePage) => void;
  routeHandler?: (route: any) => Promise<void>;
  nextPageDelayMs = 0;
  closed = false;
  readonly cdpSessions: FakeCdpSession[] = [];
  /** Issue #27: manager-issued permission grants, recorded for assertions. */
  readonly grantedPermissions: Array<{ permissions: string[]; origin: string }> = [];
  clearPermissionCalls = 0;
  setDefaultTimeout() {}
  setDefaultNavigationTimeout() {}
  async newCDPSession(page: FakePage) {
    const session = new FakeCdpSession(page);
    this.cdpSessions.push(session);
    return session;
  }
  async grantPermissions(permissions: string[], options?: { origin?: string }) {
    this.grantedPermissions.push({ permissions: [...permissions], origin: options?.origin ?? "" });
  }
  async clearPermissions() { this.clearPermissionCalls += 1; }
  async routeWebSocket() {}
  async route(_pattern: string, handler: (route: any) => Promise<void>) { this.routeHandler = handler; }
  async newPage() {
    const delayMs = this.created > 0 ? this.nextPageDelayMs : 0;
    this.nextPageDelayMs = 0;
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    const page = this.created++ === 0 ? this.page : new FakePage();
    if (!this.pageList.includes(page)) this.pageList.push(page);
    const configure = this.configureNextPage;
    this.configureNextPage = undefined;
    configure?.(page);
    this.emit("page", page);
    return page as unknown as Page;
  }
  async close() {
    this.closed = true;
    await Promise.all(this.pageList.map((page) => page.close()));
  }
}
export class FakeBrowser extends EventEmitter {
  readonly context = new FakeContext();
  connected = true;
  async newContext() { return this.context as unknown as BrowserContext; }
  contexts() { return this.context.closed ? [] : [this.context as unknown as BrowserContext]; }
  isConnected() { return this.connected; }
  async close() {
    this.connected = false;
    this.emit("disconnected");
  }
}

export function managerFixture(options: { cleanupMs?: number; hangingContextClose?: boolean; limits?: Record<string, number>; confirmationPermits?: BrowserConfirmationPermits; workspaceRoot?: string } = {}) {
  const browser = new FakeBrowser();
  if (options.hangingContextClose) browser.context.close = async () => new Promise<void>(() => undefined);
  const config = normalizeConfig({}).web!.fetch;
  let serial = 0;
  const manager = new InteractiveBrowserManager(config, {
    resolveHostname: async (hostname: string) => net.isIP(hostname) ? [hostname] : ["93.184.216.34"],
    launch: async () => browser as unknown as Browser,
    randomHandle: (kind: string) => `${kind}_${++serial}_${"x".repeat(32)}`,
    limits: { ...(options.limits ?? {}), ...(options.cleanupMs === undefined ? {} : { cleanupMs: options.cleanupMs }) },
    confirmationPermits: options.confirmationPermits,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
  });
  return { manager, browser };
}
