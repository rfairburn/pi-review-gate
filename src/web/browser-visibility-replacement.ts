/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for the visibility/service-worker controlled replacement mechanics —
 * the memory-only capture-and-validation plan built against the CURRENT
 * effective egress policy before the old browser closes, and the ordered
 * restore loop that re-adopts the replacement's tabs through the manager's
 * ordinary ownership path. Cookie/localStorage values stay inside the
 * session state object; only counts are ever reported. The manager owns
 * every lifecycle decision (serialization, idempotence, teardown trigger,
 * launch) and delegates only the capture/validate/restore mechanics here.
 */
import type { BrowserContext, Page } from "playwright";
import { boundedVisibilityUrl, optionalPublicPageUrl, validateNavigationUrl } from "./browser-url-policy.js";
import { boundedCleanup, OperationDeadline } from "./browser-operations.js";
import { asError, bounded } from "./browser-primitives.js";
import type { HostResolver } from "./network.js";
import type { InteractiveBrowserLimits } from "./browser-limits.js";
import type { BrowserPermissionGroup } from "./browser-permissions.js";

/** Structural type of a captured Playwright storage-state object; values
 * stay inside the manager and only counts are ever reported. */
export type CapturedStorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** One intended tab of a visibility replacement, in original capture order. */
export interface BrowserVisibilityTabOutcome {
  /** Recorded source URL captured before the old context closed. */
  requestedUrl: string;
  /** Actual URL after the restore navigation; null when the tab was not restored. */
  finalUrl: string | null;
  restored: boolean;
  /** True only for the tab restored as the replacement's active tab. */
  active?: boolean;
  /** Fixed bounded reason when not restored, redirected away, or demoted from active. */
  reason?: string;
}

/** Structured outcome of a settings-driven immutable-context replacement
 * (visibility and/or service-worker policy). State counts only:
 * cookie/localStorage values never leave the manager. */
export interface BrowserVisibilityResult {
  previousSession: string;
  /** New session handle; the unchanged session handle when the browser was
   * left in its current mode because no tab was restorable. */
  session: string | null;
  activeTab: string | null;
  headless: boolean;
  /** Service-worker policy of the session that remains after the call
   * (issue #27); unchanged when nothing was relaunched. */
  serviceWorkers: "allow" | "block";
  relaunched: boolean;
  tabs: BrowserVisibilityTabOutcome[];
  restoredTabs: number;
  unrestoredTabs: number;
  /** Restored tabs whose final URL differs from the requested URL. */
  urlMismatches: number;
  stateReapplied: boolean;
  /** Count-only state metadata; null when no state was captured. */
  stateCookies: number | null;
  stateOrigins: number | null;
  /** Context pages that could not be owned/restored (beyond the tab cap). */
  overflowPopups: number;
  notes: string[];
}

/** Memory-only restoration plan for a visibility replacement. Cookie and
 * localStorage values stay inside the manager; only counts are reported. */
export interface VisibilityRestorePlan {
  previousSession: string;
  storageState?: CapturedStorageState;
  /** One row per intended tab (including unrestorable pages), in original order. */
  outcomes: BrowserVisibilityTabOutcome[];
  /** Indices into `outcomes` to restore, in order, with validated hrefs. */
  restoreOrder: Array<{ index: number; href: string }>;
  /** Index into `outcomes` of the intended active tab; -1 when unknown. */
  intendedActiveIndex: number;
  overflowPopups: number;
  stateReapplied: boolean;
  stateCookies: number | null;
  stateOrigins: number | null;
  /** Manager-issued per-origin permission grants carried from the replaced
   * session (issue #27); re-applied against the CURRENT effective policy. */
  permissionGrants: Map<string, Set<BrowserPermissionGroup>>;
  notes: string[];
}

/** Capture view of the session being replaced (the manager's real object). */
export interface VisibilityCaptureSessionView {
  handle: string;
  activeTab: string;
  visible: boolean;
  serviceWorkers: "allow" | "block";
  context: BrowserContext;
  permissionGrants: Map<string, Set<BrowserPermissionGroup>>;
}

export interface VisibilityCaptureTabView {
  page: Page;
  handle: string;
}

export interface VisibilityCaptureDeps {
  limits: Readonly<InteractiveBrowserLimits>;
  resolveHostname: HostResolver;
  /** Live effective local-network permission; re-read per validation. */
  allowLocalNetworks(): boolean;
  /** Live iteration over the owned tab registry (handle/page access only). */
  tabs: Iterable<{ page: Page; handle: string }>;
  tabForPage(page: Page): VisibilityCaptureTabView | undefined;
}

/** The captured replacement plan, applied by the manager after validation. */
export interface VisibilityCapturePlan {
  outcomes: BrowserVisibilityTabOutcome[];
  intendedActiveIndex: number;
  restoreOrder: Array<{ index: number; href: string }>;
  overflowPopups: number;
  storageState?: CapturedStorageState;
  stateCookies: number | null;
  stateOrigins: number | null;
  carriedPermissionGrants: Map<string, Set<BrowserPermissionGroup>>;
  notes: string[];
}

/** Restore view of the freshly launched session (the manager's real object). */
export interface VisibilityRestoreSessionView {
  handle: string;
  activeTab: string;
  visible: boolean;
  serviceWorkers: "allow" | "block";
  context: BrowserContext;
  /** Restore-creation window state; the module arms it while its own page
   * creation is in flight so unrelated pages cannot steal that admission. */
  restoreCreationArmed: boolean;
  /** Present once the session failed; a fatal session aborts the restore. */
  fatalError?: Error | undefined;
}

export interface VisibilityRestoreTabView {
  page: Page;
  handle: string;
}

/** Narrow host interface for the restore loop: the manager owns the tab
 * registry, navigation core, popup policy, deferred-page settlement, page
 * containment, carried-grant re-application, and foreground mechanics. */
export interface VisibilityRestoreHost {
  limits: Readonly<InteractiveBrowserLimits>;
  navigate(
    session: VisibilityRestoreSessionView,
    tab: VisibilityRestoreTabView,
    href: string,
    deadline: OperationDeadline,
    isPrimaryTab: boolean,
    onDispatch?: () => void,
  ): Promise<{ url: string }>;
  tabForPage(session: VisibilityRestoreSessionView, page: Page): VisibilityRestoreTabView | undefined;
  adoptPage(
    session: VisibilityRestoreSessionView,
    page: Page,
    popup: boolean,
    restoringOwnedTab: boolean,
  ): VisibilityRestoreTabView | undefined;
  settleDeferredRestorePages(session: VisibilityRestoreSessionView): void;
  containRefusedPage(session: VisibilityRestoreSessionView, page: Page, label: string): Promise<void>;
  trackLatePageCreation(session: VisibilityRestoreSessionView, creation: Promise<Page>, label: string): void;
  reapplyCarriedPermissionGrants(session: VisibilityRestoreSessionView, restore: VisibilityRestorePlan): Promise<void>;
  foregroundRestoredTab(session: VisibilityRestoreSessionView, handle: string): Promise<void>;
}

/** Capture and validate the replacement plan of the session about to be
 * replaced: the actual context pages, the human-foregrounded tab, the
 * memory-only storage-state snapshot, and every intended URL revalidated
 * against the CURRENT effective egress policy before any browser closes. */
export async function captureVisibilityPlan(
  existing: VisibilityCaptureSessionView,
  deps: VisibilityCaptureDeps,
): Promise<VisibilityCapturePlan> {
    const notes: string[] = [];
    const outcomes: BrowserVisibilityTabOutcome[] = [];
    const intended: Array<{ index: number; rawUrl: string; tabHandle: string }> = [];
    let intendedActiveIndex = -1;
    let overflowPopups = 0;
    let storageState: CapturedStorageState | undefined;
    let stateCookies: number | null = null;
    let stateOrigins: number | null = null;
    // Issue #27: carry the manager-issued per-origin permission grants (and
    // only those) into the replacement context so a settings-driven
    // replacement never silently drops granted clipboard/device authority.
    // Re-application re-checks the CURRENT effective policy per group, so a
    // revocation saved in the same transaction cannot ride along.
    const carriedPermissionGrants: Map<string, Set<BrowserPermissionGroup>> = new Map();
    for (const [origin, groups] of existing.permissionGrants) {
      if (groups.size > 0) carriedPermissionGrants.set(origin, new Set(groups));
    }
    const restoreOrder: Array<{ index: number; href: string }> = [];

    // The manager holds the session's busy lock across capture and validation
    // (operation serialization stays manager-owned); this function holds
    // exactly the capture/validation mechanics of that window.
      const captureDeadline = new OperationDeadline("BrowserVisibility capture", deps.limits.navigationMs);
      try {
        // Enumerate the ACTUAL context pages, including human-opened popups.
        // Pages without owned-tab membership were contained at the tab cap and
        // are reported, never silently dropped.
        for (const page of existing.context.pages()) {
          const tab = deps.tabForPage(page);
          const reportedUrl = boundedVisibilityUrl(page.url());
          if (!tab) {
            overflowPopups += 1;
            outcomes.push({ requestedUrl: reportedUrl, finalUrl: null, restored: false, reason: "context page beyond the owned-tab limit; it was contained and cannot be restored" });
            continue;
          }
          intended.push({ index: outcomes.length, rawUrl: page.url(), tabHandle: tab.handle });
          outcomes.push({ requestedUrl: reportedUrl, finalUrl: null, restored: false });
        }
        // Human-selected tab awareness (best effort): in a real window exactly
        // one tab reports document.visibilityState === "visible" — the one the
        // human is actually looking at. When that differs from the model's
        // recorded active tab, the foregrounded tab is restored as active so a
        // follow-up model operation acts on the real current page. Unobservable
        // states (headless, multiple, read failure) fall back to the recorded
        // active tab.
        const foreground: string[] = [];
        for (const tab of deps.tabs) {
          if (tab.page.isClosed()) continue;
          try {
            const state = await boundedCleanup(
              tab.page.evaluate(() => document.visibilityState),
              Math.min(1_000, deps.limits.actionMs),
              "foreground tab detection",
            );
            if (state === "visible") foreground.push(tab.handle);
          } catch {
            // Foreground state unobservable for this tab; recorded active stays the fallback.
          }
        }
        let intendedHandle = existing.activeTab;
        if (foreground.length === 1 && foreground[0] !== existing.activeTab) {
          intendedHandle = foreground[0];
          notes.push("The tab currently foregrounded in the browser window differs from the model's recorded active tab; the foregrounded tab is restored as active.");
        }
        intendedActiveIndex = intended.findIndex((entry) => entry.tabHandle === intendedHandle);
        // Capture the session state object in memory only: cookies, localStorage,
        // and IndexedDB ride back into the replacement context as a plain object.
        // IndexedDB is captured explicitly (pinned Playwright omits it by default)
        // because IndexedDB-backed sessions are common. Nothing is written to
        // disk and values never leave the manager; only counts are reported.
        // This is best-effort, never lossless.
        try {
          storageState = await captureDeadline.run(existing.context.storageState({ indexedDB: true }), "browser state capture");
          stateCookies = storageState.cookies.length;
          stateOrigins = storageState.origins.length;
        } catch (error) {
          notes.push(`Session state capture failed (${bounded(asError(error).message, 200)}); the replacement restores tabs without stored cookies/localStorage.`);
        }
      } finally {
        captureDeadline.dispose();
      }

      // Validate every intended URL against the CURRENT effective egress
      // policy BEFORE closing, so a browser whose tabs are all unrestorable is
      // left intact instead of being destroyed for an empty replacement. The
      // same effective local-network permission that admitted the original
      // navigation (issue #27) decides here: a user-authorized local tab must
      // not be dropped by a public-only validator, and a revocation saved in
      // the meantime is honored before any browser is destroyed.
      const validationDeadline = new OperationDeadline("BrowserVisibility URL validation", deps.limits.navigationMs);
      try {
        for (const entry of intended) {
          try {
            const validated = await validationDeadline.run(
              validateNavigationUrl(entry.rawUrl, deps.resolveHostname, { allowLocalNetworks: deps.allowLocalNetworks() }),
              "URL validation",
            );
            restoreOrder.push({ index: entry.index, href: validated.href });
          } catch (error) {
            outcomes[entry.index]!.reason = `recorded URL no longer passes the public-URL egress policy (${bounded(asError(error).message, 200)}); the intended tab is preserved here but cannot be restored`;
          }
        }
      } finally {
        validationDeadline.dispose();
      }
      return {
    outcomes,
    intendedActiveIndex,
    restoreOrder,
    overflowPopups,
    storageState,
    stateCookies,
    stateOrigins,
    carriedPermissionGrants,
    notes,
  };
}

/**
 * Restore the validated ordered tabs of a visibility replacement into a
 * freshly launched session, recording requested/final URLs and failures
 * per tab. Per-tab failures never abort the relaunch unless the session
 * itself became fatal. The manager performs the idle-lease renewal, the
 * operation-serialization release, and output protection around this call.
 */
export async function restoreVisibilityTabs(
  session: VisibilityRestoreSessionView,
  primaryTab: VisibilityRestoreTabView,
  restore: VisibilityRestorePlan,
  host: VisibilityRestoreHost,
  operationSignal: AbortSignal,
  onDispatch?: () => void,
): Promise<BrowserVisibilityResult> {
    const restoredHandles = new Map<number, string>();
    let primaryUsed = false;
    for (const entry of restore.restoreOrder) {
      const outcome = restore.outcomes[entry.index]!;
      const deadline = new OperationDeadline("BrowserVisibility restore", host.limits.navigationMs, operationSignal);
      let tab: VisibilityRestoreTabView | undefined;
      try {
        if (!primaryUsed) {
          tab = primaryTab;
          primaryUsed = true;
        } else {
          // Issue #27 integration: this page re-adopts a tab the replaced
          // session already owned (its URL passed validation against the
          // CURRENT egress policy before the old browser was closed), so it is
          // admitted even at the ordinary new-tab cap — including popup tabs
          // admitted under a model popup restriction override that has since
          // been disabled. The admission is identity-scoped to exactly this
          // page, one per validated snapshot tab: it grants no new popup
          // creation authority and leaves no standing over-limit allowance.
          // While the creation is in flight, arriving unowned pages are
          // deferred (settleDeferredRestorePages) so a racing page-created
          // popup can never steal this admission.
          session.restoreCreationArmed = true;
          // Always through a promise: even a synchronous throw from newPage()
          // must reach the catch below so the armed window is settled and no
          // deferred page is stranded.
          const creation = Promise.resolve().then(() => session.context.newPage());
          let page: Page;
          try {
            page = await deadline.run(creation, "browser tab creation");
          } catch (error) {
            host.trackLatePageCreation(session, creation, "late visibility restore page creation");
            host.settleDeferredRestorePages(session);
            throw asError(error);
          }
          const adopted = host.tabForPage(session, page) ?? host.adoptPage(session, page, false, true);
          host.settleDeferredRestorePages(session);
          if (!adopted) {
            await host.containRefusedPage(session, page, "refused visibility restore page");
            throw new Error("visibility restore tab could not be owned within the session tab limit.");
          }
          tab = adopted;
        }
        const navigation = await host.navigate(session, tab, entry.href, deadline, tab === primaryTab, onDispatch);
        outcome.restored = true;
        outcome.finalUrl = navigation.url;
        restoredHandles.set(entry.index, tab.handle);
      } catch (error) {
        const failure = asError(error);
        outcome.restored = false;
        outcome.finalUrl = optionalPublicPageUrl(tab?.page.url());
        outcome.reason = bounded(failure.message, 300);
        // A session-fatal failure (broker refusal, process loss) aborts the
        // relaunch truthfully through the ordinary open failure path. An
        // aborted opening signal (Pi shutdown/reload mid-restore) is equally
        // fatal for the restore: it must surface as the structured open
        // cancellation, never as a successful immediate switch.
        if (session.fatalError || operationSignal.aborted) throw failure;
      } finally {
        deadline.dispose();
      }
    }

    // Active tab: the intended one when it was restored, otherwise the last
    // successfully restored tab, disclosed when that differs.
    const intendedActive = restore.intendedActiveIndex >= 0 ? restore.outcomes[restore.intendedActiveIndex] : undefined;
    let activeIndex = -1;
    if (intendedActive?.restored && restoredHandles.has(restore.intendedActiveIndex)) {
      activeIndex = restore.intendedActiveIndex;
    } else {
      for (const entry of restore.restoreOrder) {
        if (restore.outcomes[entry.index]!.restored) activeIndex = entry.index;
      }
    }
    if (activeIndex >= 0) {
      const activeHandle = restoredHandles.get(activeIndex)!;
      session.activeTab = activeHandle;
      restore.outcomes[activeIndex]!.active = true;
      // Best-effort foreground: in a headed window this makes the restored
      // active tab the tab the human sees. Bounded and non-fatal.
      try {
        await host.foregroundRestoredTab(session, activeHandle);
      } catch (error) {
        restore.notes.push(`Restored active tab could not be brought to the foreground: ${bounded(asError(error).message, 200)}.`);
      }
    } else if (intendedActive && !intendedActive.restored) {
      intendedActive.reason ??= "intended active tab could not be restored";
      restore.notes.push("The intended active tab could not be restored; the last successfully restored tab is active.");
    }

    const restoredTabs = restore.outcomes.filter((outcome) => outcome.restored).length;
    let urlMismatches = 0;
    for (const entry of restore.restoreOrder) {
      const outcome = restore.outcomes[entry.index]!;
      if (!outcome.restored) continue;
      const expectedUrl = optionalPublicPageUrl(entry.href) ?? entry.href;
      if (outcome.finalUrl !== expectedUrl) {
        urlMismatches += 1;
        outcome.reason = "restored to a different final URL than requested; the server redirected the page (session-state loss or a site redirect) — the requested URL is recorded above";
      }
    }
    if (urlMismatches > 0) {
      restore.notes.push(`${urlMismatches} restored tab(s) ended at a different URL than requested; memory-only session state is best-effort and any resulting redirect is disclosed per tab.`);
    }
    // Issue #27: re-apply the carried per-origin permission grants against the
    // CURRENT effective policy. Groups revoked by the same settings save are
    // dropped (never re-issued); a failed engine grant drops that origin's
    // bookkeeping so the map never claims authority the context lacks.
    await host.reapplyCarriedPermissionGrants(session, restore);
    // A revocation that could not be confirmed on the replacement context
    // failed the new session to contain the retained grant; report it through
    // the ordinary open-failure path instead of returning a usable-looking
    // result for a dying session.
    if (session.fatalError) throw session.fatalError;
    return {
      previousSession: restore.previousSession,
      session: session.handle,
      activeTab: session.activeTab,
      headless: !session.visible,
      serviceWorkers: session.serviceWorkers,
      relaunched: true,
      tabs: restore.outcomes,
      restoredTabs,
      unrestoredTabs: restore.outcomes.length - restoredTabs,
      urlMismatches,
      stateReapplied: restore.stateReapplied,
      stateCookies: restore.stateCookies,
      stateOrigins: restore.stateOrigins,
      overflowPopups: restore.overflowPopups,
      notes: restore.notes,
    };
}
