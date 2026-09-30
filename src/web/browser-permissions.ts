/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for the manager-issued per-origin permission bookkeeping — the
 * composable group tables, the serialized grant/revocation state machine,
 * the page-commit device-grant chain, replacement-state carryover, and the
 * structured revocation outcomes. Modules only ever mutate the delegated
 * `permissionGrants`/`permissionGrantTail` substate on the same session
 * objects the manager created; engine clearing that cannot be confirmed is
 * still contained fail-closed through the supplied `failSession` callback
 * (the manager's ordinary teardown), and the live effective policy is
 * re-read at every point the original code read it.
 */
import type { BrowserContext } from "playwright";
import type { EffectiveBrowserPolicy } from "./browser-capabilities.js";
import { BrowserCapabilityDeniedError } from "./browser-errors.js";
import { bounded, asError } from "./browser-primitives.js";

export type BrowserPermissionGroup = "clipboard_read" | "clipboard_write" | "camera" | "microphone" | "geolocation";

/** Playwright permission descriptors issued per granted group. Groups are
 * per-direction/per-device so an approval for one operation never silently
 * grants another direction or device to that origin (least privilege). */
const BROWSER_PERMISSION_GROUP_GRANTS: Record<BrowserPermissionGroup, readonly string[]> = {
  clipboard_read: ["clipboard-read"],
  clipboard_write: ["clipboard-write"],
  camera: ["camera"],
  microphone: ["microphone"],
  geolocation: ["geolocation"],
};

/** Every permission group the modelClipboard setting controls (issue #27). */
export const CLIPBOARD_PERMISSION_GROUPS: readonly BrowserPermissionGroup[] = ["clipboard_read", "clipboard_write"];

/** Device permission groups and the effective-policy flag that enables each.
 * These are page-requested capabilities: the manager issues per-origin state
 * so a page's own getUserMedia/geolocation call is not denied; it never
 * activates a device, injects media, or fabricates coordinates. */
export const DEVICE_PERMISSION_GROUPS: ReadonlyArray<{
  group: BrowserPermissionGroup;
  enabled: (policy: EffectiveBrowserPolicy) => boolean;
}> = [
  { group: "camera", enabled: (policy) => policy.modelCamera },
  { group: "microphone", enabled: (policy) => policy.modelMicrophone },
  { group: "geolocation", enabled: (policy) => policy.modelGeolocation },
];

/** Device groups currently enabled by the effective policy (issue #27). */
export function enabledDeviceGroups(policy: EffectiveBrowserPolicy): BrowserPermissionGroup[] {
  return DEVICE_PERMISSION_GROUPS.filter((entry) => entry.enabled(policy)).map((entry) => entry.group);
}

/** Whether one permission group is enabled by the current effective policy.
 * Used when re-applying carried grants after a controlled replacement so a
 * settings change that triggered the replacement cannot re-issue a revoked
 * capability. */
export function permissionGroupEnabled(group: BrowserPermissionGroup, policy: EffectiveBrowserPolicy): boolean {
  if (group === "clipboard_read" || group === "clipboard_write") return policy.modelClipboard;
  const entry = DEVICE_PERMISSION_GROUPS.find((candidate) => candidate.group === group);
  return entry ? entry.enabled(policy) : false;
}

/**
 * Issue #27 clipboard capability gate. Checked against the current
 * effective policy at every call site (initial gate and again after
 * post-approval revalidation), so a settings change between them cannot
 * leave a stale permission in force.
 */
export function enforceClipboardCapability(policy: EffectiveBrowserPolicy): void {
  if (!policy.modelClipboard) {
    throw new BrowserCapabilityDeniedError("model_clipboard");
  }
}

/** Outcome of one live session's permission revocation (issue #27).
 * Every path is reported truthfully: an engine clear that cannot be confirmed
 * never resolves as success — the affected session is failed and torn down to
 * contain the retained grants, and that containment (with its confirmation
 * status) is what gets reported. */
export type BrowserPermissionRevocationOutcome =
  | { status: "no_grant" }
  /** A concurrent teardown already contains this context; its close kills the engine grants. */
  | { status: "superseded"; reason: string }
  /** The clear was confirmed; surviving enabled groups were re-issued, except the listed safe losses. */
  | { status: "revoked"; regrantFailures: Array<{ origin: string; reason: string }> }
  /** The clear could not be confirmed; the session was closed to contain the retained grants. */
  | { status: "unconfirmed"; reason: string }
  /** The mutation tail did not settle within the cleanup deadline (a wedged driver): the revocation is still in flight and unconfirmed; the affected session was closed to contain any retained grants. */
  | { status: "in_flight"; reason: string };

/** One live session's revocation outcome, plus — when a containment teardown
 * is involved (an unconfirmed clear or a timed-out in-flight wait started one,
 * or a superseded revocation observed an in-progress one) — whether that
 * teardown itself was confirmed. */
export interface BrowserPermissionRevocationEntry {
  session: string;
  outcome: BrowserPermissionRevocationOutcome;
  closure?: "confirmed" | "unconfirmed";
}

/** The revocation report returned by updateConfig for one settings save. */
export interface BrowserPermissionRevocationReport {
  entries: BrowserPermissionRevocationEntry[];
}

export interface BrowserPermissionSessionView {
  context: BrowserContext;
  permissionGrants: Map<string, Set<BrowserPermissionGroup>>;
  /** Serialization tail for every permission mutation (grant/revoke) on this
   * session. Mutated in place on the manager-owned session object. */
  permissionGrantTail: Promise<void>;
  /** Bounded disclosure channel (the session's broker ledger). */
  broker: { note(message: string): void };
  /** Present once teardown began. */
  teardown?: PromiseLike<unknown> | undefined;
  /** Present when a fatal error is recorded; the session must not continue. */
  fatalError?: Error | undefined;
}

/** Serialize one per-origin permission mutation behind this session's tail.
 * The stored tail swallows rejections so one failed mutation cannot wedge
 * later ones; the caller still receives its own result. */
export function serializePermissionMutation<T>(session: BrowserPermissionSessionView, body: () => Promise<T>): Promise<T> {
    // The stored tail never rejects (rejections are swallowed below), so a
    // single onfulfilled is sufficient to chain after the previous mutation.
    const next = session.permissionGrantTail.then(() => body());
    session.permissionGrantTail = next.then(() => undefined, () => undefined);
    return next;
  }

export async function ensurePermissionGrant(session: BrowserPermissionSessionView, origin: string, group: BrowserPermissionGroup): Promise<void> {
    await serializePermissionMutation(session, async () => {
      const granted = session.permissionGrants.get(origin) ?? new Set<BrowserPermissionGroup>();
      if (granted.has(group)) return;
      // Chromium's grantPermissions replaces the origin's allowed set, so
      // every call must carry the union of all groups held for that origin.
      const descriptors = new Set<string>();
      for (const held of [...granted, group]) {
        for (const descriptor of BROWSER_PERMISSION_GROUP_GRANTS[held]) descriptors.add(descriptor);
      }
      await session.context.grantPermissions([...descriptors], { origin });
      // Bookkeeping commits only after the engine accepted the grant, so a
      // failed grant never leaves the map claiming a permission it lacks.
      granted.add(group);
      session.permissionGrants.set(origin, granted);
    });
  }

/** Clipboard wrapper with the operation's precise not_started denial. */
export async function ensureClipboardGrant(session: BrowserPermissionSessionView, origin: string, group: BrowserPermissionGroup): Promise<void> {
    try {
      await ensurePermissionGrant(session, origin, group);
    } catch {
      throw new Error("BrowserClipboard not_started: the manager could not issue the per-origin clipboard permission grant; no clipboard operation was attempted.");
    }
  }

  /**
   * Issue #27 device capability enforcement (camera/microphone/geolocation).
   * When an owned tab commits a top-level document on an HTTP(S) origin, the
   * manager issues a real per-origin Playwright permission grant for every
   * device group the CURRENT effective policy enables — so a page's own
   * getUserMedia/getCurrentPosition call is not denied by the manager while
   * the capability is on. This grants permission state only: it never
   * activates a device, injects media, or fabricates coordinates; actual
   * capture/position availability is decided by the real device and OS and
   * reported by the page honestly. A failed grant fails closed (the request
   * stays denied) and is noted, never session-fatal.
 */
export async function grantDevicePermissionsForPage(
  session: BrowserPermissionSessionView,
  policy: () => EffectiveBrowserPolicy,
  pageUrl: () => string,
  failSession: (error: Error) => void,
): Promise<void> {
  if (session.teardown || session.fatalError) return;
  const groups = enabledDeviceGroups(policy());
  if (groups.length === 0) return;
  let origin: string;
    try {
      const url = new URL(pageUrl());
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      origin = url.origin;
    } catch {
      return; // No stable origin yet (about:blank mid-navigation); the next commit re-evaluates.
    }
    for (const group of groups) {
      if (session.teardown || session.fatalError) return;
      // Re-check the LIVE policy before each group: a revocation that landed
      // between two groups of this chain must never be re-granted by it.
      if (!permissionGroupEnabled(group, policy())) return;
      try {
        await ensurePermissionGrant(session, origin, group);
      } catch (error) {
        // Fail closed: the device permission simply stays denied.
        session.broker.note(`device permission grant failed for ${bounded(origin, 200)}: ${bounded(asError(error).message, 200)}`);
        return;
      }
      // Reconcile after the round-trip exactly like the clipboard path: a
      // revocation can queue its clear before this grant commits. A clear
      // that cannot be confirmed fails the session (contained by teardown);
      // disclose it in the broker ledger because this chain is fire-and-
      // forget — the settings save that caused the revocation reports the
      // outcome through its own channel, and later operations see the fatal
      // error.
      if (!permissionGroupEnabled(group, policy())) {
        const outcome = await revokePermissionGrants(session, failSession, [group]);
        if (outcome.status === "unconfirmed") {
          session.broker.note(`device permission revocation for ${bounded(origin, 200)} could not be confirmed (${outcome.reason}); the session was closed to contain the retained grant.`);
        }
        return;
      }
    }
}

  /**
   * Issue #27 replacement-state carryover. After a controlled visibility or
   * service-worker replacement, re-issue the replaced session's recorded
   * per-origin grants into the new context — but only the groups still
   * enabled by the CURRENT effective policy (the same save that triggered the
   * replacement may have revoked some). Best-effort and fail closed: a failed
   * grant drops that origin from the bookkeeping and is disclosed in the
   * result notes rather than claimed.
 */
export async function reapplyCarriedPermissionGrants(
  session: BrowserPermissionSessionView,
  policy: () => EffectiveBrowserPolicy,
  restore: { permissionGrants: Map<string, Set<BrowserPermissionGroup>>; notes: string[] },
  failSession: (error: Error) => void,
): Promise<void> {
    for (const [origin, carried] of restore.permissionGrants) {
      if (session.teardown || session.fatalError) break;
      let failedAt: BrowserPermissionGroup | undefined;
      let failure: string | undefined;
      for (const group of carried) {
        // Live-policy re-check per group, not the snapshot taken before the
        // restore awaits: a mid-reapply revocation must not be re-issued.
        if (!permissionGroupEnabled(group, policy())) continue;
        try {
          await ensurePermissionGrant(session, origin, group);
        } catch (error) {
          // ensurePermissionGrant commits bookkeeping only after the engine
          // accepts, so on failure the map already matches the engine exactly;
          // nothing is rolled back and nothing is claimed. The un-reapplied
          // groups stay off (fail closed) until their next natural trigger —
          // an approved clipboard operation or a navigation commit.
          failedAt = group;
          failure = bounded(asError(error).message, 200);
          break;
        }
        if (!permissionGroupEnabled(group, policy())) {
          const outcome = await revokePermissionGrants(session, failSession, [group]);
          if (outcome.status === "unconfirmed") {
            // The replacement context retained a just-revoked grant and its
            // clear could not be confirmed: the new session was failed and
            // torn down to contain it. Disclose; the caller reports the
            // failure through the ordinary open-failure path.
            restore.notes.push(`Permission revocation for ${bounded(origin, 200)} could not be confirmed on the replacement browser (${outcome.reason}); the replacement session was closed to contain the retained grant.`);
            return;
          }
        }
      }
      if (failedAt !== undefined) {
        restore.notes.push(`Permission grants for ${bounded(origin, 200)} were only partially re-applied to the replacement browser (stopped at ${failedAt}: ${failure}); the un-reapplied groups are off until their next applicable action or navigation.`);
      }
    }
  }

  /** Re-issue exactly the union of each origin's recorded groups after a
   * confirmed engine clear. The context is launched with no permissions and
   * this manager is its only grantor, so afterwards the engine matches the
   * bookkeeping map by construction; each re-grant carries the full union
   * because Chromium replaces the origin's allowed set. A failed re-grant is
   * a SAFE loss (the confirmed clear means the engine holds no permission for
   * that origin): its record is dropped so bookkeeping never claims authority
   * the context lacks, and the failure is returned for honest reporting
   * instead of being claimed. Origins are independent in Chromium, so one
 * failure does not withhold the other origins' surviving grants. */
async function regrantPermissionGrants(session: BrowserPermissionSessionView): Promise<Array<{ origin: string; reason: string }>> {
  const failures: Array<{ origin: string; reason: string }> = [];
    for (const [origin, granted] of [...session.permissionGrants]) {
      if (granted.size === 0) {
        session.permissionGrants.delete(origin);
        continue;
      }
      const descriptors = new Set<string>();
      for (const held of granted) {
        for (const descriptor of BROWSER_PERMISSION_GROUP_GRANTS[held]) descriptors.add(descriptor);
      }
      try {
        await session.context.grantPermissions([...descriptors], { origin });
      } catch (error) {
        // Drop the record: the cleared context holds nothing for this origin
        // now, and the group is off until its next natural trigger — an
        // approved clipboard operation or a navigation commit.
        session.permissionGrants.delete(origin);
        failures.push({ origin, reason: bounded(asError(error).message, 200) });
      }
    }
  return failures;
}

  /** Remove the named groups' grants from every origin in a live context.
   * The engine clear is confirmed before the bookkeeping forgets the groups.
   * A clear that cannot be confirmed is fail-closed: the bookkeeping records
   * survive (the engine may still hold the revoked groups) and the affected
   * session is failed through the ordinary teardown machinery, so the
   * retained grants die with a confirmed context close — never reported as
   * successfully revoked. The post-grant re-check in clipboard() forces a
   * second revocation after any in-flight grant commits, so that race stays
   * closed. This method never rejects: every failure mode resolves to a
 * structured outcome with containment already applied. */
export async function revokePermissionGrants(
  session: BrowserPermissionSessionView,
  failSession: (error: Error) => void,
  groups: readonly BrowserPermissionGroup[],
): Promise<BrowserPermissionRevocationOutcome> {
  try {
      return await serializePermissionMutation(session, () => revokePermissionGrantBody(session, failSession, groups));
    } catch (error) {
      // An unexpected manager failure inside the serialized mutation is
      // contained exactly like an unconfirmed clear: a revoked capability
      // must never leave its grants live without containment or reporting.
      const reason = bounded(asError(error).message, 200);
      if (!session.teardown && !session.fatalError) {
        failSession(new Error(`Browser permission revocation failed (${reason}); the browser session was closed to contain any retained grants.`));
      }
      return { status: "unconfirmed", reason };
    }
  }

async function revokePermissionGrantBody(
  session: BrowserPermissionSessionView,
  failSession: (error: Error) => void,
  groups: readonly BrowserPermissionGroup[],
): Promise<BrowserPermissionRevocationOutcome> {
    const groupSet = new Set<BrowserPermissionGroup>(groups);
    let holdsGroup = false;
    for (const granted of session.permissionGrants.values()) {
      for (const held of granted) {
        if (groupSet.has(held)) { holdsGroup = true; break; }
      }
      if (holdsGroup) break;
    }
    if (!holdsGroup) return { status: "no_grant" };
    // A concurrent teardown (visibility replacement, idle expiry, explicit
    // close, or an earlier failure) already contains this context: its close
    // kills the engine grants, so no new containment is started or claimed.
    if (session.teardown || session.fatalError) {
      return { status: "superseded", reason: bounded((session.fatalError ?? new Error("teardown in progress")).message, 200) };
    }

    try {
      await session.context.clearPermissions();
    } catch (error) {
      // The engine may still hold the revoked groups. The bookkeeping is
      // deliberately untouched so the unresolved records survive until the
      // context close is confirmed; contain by failing the owned session, and
      // report the unconfirmed state instead of claiming the clear.
      if (session.teardown || session.fatalError) {
        return { status: "superseded", reason: bounded((session.fatalError ?? new Error("teardown in progress")).message, 200) };
      }
      const reason = bounded(asError(error).message, 200);
      failSession(new Error(`Browser permission revocation could not be confirmed (${reason}); the browser session was closed to contain the retained grants.`));
      return { status: "unconfirmed", reason };
    }
    // Confirmed clear: forget exactly the revoked groups, then re-issue the
    // surviving union for every origin (Chromium replaces per-origin sets).
    for (const granted of session.permissionGrants.values()) {
      for (const group of groups) granted.delete(group);
    }
    const regrantFailures = await regrantPermissionGrants(session);
    if (regrantFailures.length > 0) {
      session.broker.note(`permission re-grant after a revocation clear failed for ${regrantFailures.length} origin(s) (${regrantFailures.map((entry) => bounded(entry.origin, 120)).join(", ")}); those grants are off until their next applicable action or navigation.`);
    }
    return { status: "revoked", regrantFailures };
  }
