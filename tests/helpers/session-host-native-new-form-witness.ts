/**
 * Test-only POSITIVE witnesses for one real keystroke in the real New form's
 * Workspace field (issue #277 native Main host acceptance).
 *
 * `MainPtyDriver.createNativeSession` and the native CLI Main scenario press one
 * Enter into the Workspace field and then have to decide, from what the drawn
 * frame actually shows, whether that Enter already took the submission or only
 * accepted the field's exact owned-folder completion (the field's documented
 * semantics: Enter confirms the highlighted completion while that list is open
 * and submits only when it is not). Deciding that from the ABSENCE of the
 * `> Workspace:` row is a false positive: `SessionHostFrameWriter` repaints only
 * the rows that changed, with no atomic frame marker, so a partial redraw can
 * briefly draw no Workspace row at all while the form is still open, still owns
 * focus, and has submitted nothing. A driver that reads that as "submitted"
 * skips the one intended second Enter and the New form is never taken.
 *
 * Every witness here is therefore positive: the host's own pending-create row, a
 * start the child itself freshly reported for this exact workspace (fenced
 * against every identity that already existed), or the exact completed owned
 * folder drawn in a complete New form. An empty, partial, or marker-missing
 * redraw yields no witness at all, so the caller keeps waiting instead of acting
 * on a frame that proved nothing, and the caller branches on the witness it
 * captured rather than on a later transient frame.
 *
 * This module is deliberately a leaf: it depends on nothing but the shared
 * roster geometry, so both the native Main harness and the native CLI Main
 * scenario can share one completion semantics. (The stricter bordered-Editor
 * New-open witness in `session-host-native-saved-main-harness.ts` cannot be
 * imported here: that harness imports the native Main harness, and a witness
 * module must not close that cycle.)
 *
 * These are synthetic test-UI readiness witnesses only. They say what the drawn
 * Main frame and a fixture's own journal showed to this driver; they are never a
 * provider's activity or status, and they add no key, retry, or sleep anywhere.
 */
import { NATIVE_PANE_START } from "./session-host-native-roster-witness";

/** The drawn New form's editable Workspace row, exactly as `SidebarController` labels it. */
export const NEW_FORM_WORKSPACE_MARKER = "> Workspace:";
/** The New form's own form-pane header row. */
const NEW_FORM_PANE_HEADER = "New session";
/**
 * Hints ONLY the New form's footer draws (`enter create`, `tab complete`; the
 * Edit form draws `save`/`cancel` instead and the roster draws `open`/`hide`).
 * A New form whose footer is not drawn is not a complete New form.
 */
const NEW_FORM_FOOTER_HINTS = ["enter create", "tab complete"] as const;
/** The host's own pending-create row, as drawn while a create request is in flight. */
const PENDING_CREATE_ROW = /(?:^|[^\w])Starting \(request \d+\)/u;

/**
 * One positively observed start event, of whichever journal reported it. `type`
 * is optional because these records come straight from parsed JSONL.
 */
export interface StartEventCandidate {
  readonly type?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly sessionId?: string;
}

/**
 * Identities already observed BEFORE the keystroke being witnessed. A start
 * carrying any of them is an older child, never the fresh one this create made.
 */
export interface StartIdentityFence {
  readonly pids: ReadonlySet<number>;
  readonly sessionIds: ReadonlySet<string>;
}

/**
 * The matched witness, carrying the exact frame (and record) that matched, so
 * the caller branches on captured evidence instead of re-reading a later frame
 * that may have moved on either way.
 */
export type WorkspaceSubmitWitness<TFreshStart> =
  | { readonly kind: "pending-create"; readonly frame: string }
  | { readonly kind: "fresh-start"; readonly frame: string; readonly start: TFreshStart }
  | { readonly kind: "owned-folder-completion"; readonly frame: string; readonly completedPath: string };

/** The form pane's rows: Main's own header row, then everything right of the roster. */
function formPaneRows(frame: string): string[] {
  return frame.split("\n").slice(1).map((line) => line.slice(NATIVE_PANE_START));
}

/**
 * The value drawn on a labelled Workspace row, or nothing when that row is not
 * drawn. The label sits beside the row that carries the editable content, so the
 * value is read from the labelled row itself, never from the Editor's rule above
 * it; a label with nothing drawn after it has no content region to read.
 */
function rowWorkspaceValue(row: string, marker: string = NEW_FORM_WORKSPACE_MARKER): string | undefined {
  const index = row.indexOf(marker);
  if (index < 0) return undefined;
  const drawn = row.slice(index + marker.length);
  if (drawn.length === 0) return undefined;
  return drawn.trim();
}

/**
 * The value drawn on the New form's labelled Workspace row in the form pane, or
 * nothing when no such row is drawn.
 */
export function newFormWorkspaceValue(
  frame: string,
  marker: string = NEW_FORM_WORKSPACE_MARKER,
): string | undefined {
  for (const row of formPaneRows(frame)) {
    const value = rowWorkspaceValue(row, marker);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** True only when the frame draws the New form's own footer hints. */
export function newFormFooterDrawn(frame: string): boolean {
  return NEW_FORM_FOOTER_HINTS.every((hint) => frame.includes(hint));
}

/** True only when the host's actual pending-create row is drawn. */
export function newFormPendingCreateDrawn(frame: string): boolean {
  return PENDING_CREATE_ROW.test(frame);
}

/**
 * True only for a COMPLETELY drawn New form: its own form-pane header row, a
 * labelled Workspace row drawn below it, and its own footer hints on screen. The
 * left roster's identically named `New session` action is not the form pane, and
 * a repaint that lost the label or the footer is not a complete form — so marker
 * absence alone is never read as a submitted form.
 */
export function completeNewFormDrawn(frame: string): boolean {
  if (!newFormFooterDrawn(frame)) return false;
  const pane = formPaneRows(frame);
  const header = pane.findIndex((row) => row.trim() === NEW_FORM_PANE_HEADER);
  if (header < 0) return false;
  return pane.slice(header + 1).some((row) => rowWorkspaceValue(row) !== undefined);
}

/**
 * A start event this child reported freshly for exactly `workspace`, or nothing.
 * The event must name the exact workspace, report a usable PID that did not
 * exist before the witnessed keystroke, and (when it reports a conversation id)
 * carry one that did not exist either, so an older row can never stand in.
 */
export function observeFreshStart<T extends StartEventCandidate>(
  records: readonly T[],
  options: {
    readonly workspace: string;
    readonly startType: string;
    readonly fence: StartIdentityFence;
  },
): T | undefined {
  const { workspace, startType, fence } = options;
  for (const record of records) {
    if (record.type !== startType) continue;
    if (record.cwd !== workspace) continue;
    if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid) || record.pid <= 0) continue;
    if (fence.pids.has(record.pid)) continue;
    if (typeof record.sessionId === "string" && record.sessionId.length > 0 && fence.sessionIds.has(record.sessionId)) {
      continue;
    }
    return record;
  }
  return undefined;
}

/** Snapshot every start identity already observed, to fence a later witness with. */
export function captureStartIdentities(records: readonly StartEventCandidate[]): StartIdentityFence {
  const pids = new Set<number>();
  const sessionIds = new Set<string>();
  for (const record of records) {
    if (typeof record.pid === "number") pids.add(record.pid);
    if (typeof record.sessionId === "string" && record.sessionId.length > 0) sessionIds.add(record.sessionId);
  }
  return { pids, sessionIds };
}

/**
 * Observe what one Workspace Enter actually did, from positive evidence only.
 *
 * The witnesses are checked in that order of consequence: the host's own
 * pending-create row, then a freshly reported start for this exact workspace,
 * and only then the exact completed owned folder inside a complete New form, so
 * a start the real host already took can never be outranked by a form frame that
 * is merely still on screen — the second Enter is never sent into a child that
 * has taken input ownership. Anything else — an empty frame, a partial repaint,
 * a frame that simply lost the Workspace row, a field holding another path or an
 * error — returns nothing and the caller keeps waiting.
 */
export function observeWorkspaceSubmitWitness<TFreshStart>(
  frame: string,
  options: {
    /** The exact value the field draws once it accepted this owned folder. */
    readonly completedPath: string;
    /** This child's own freshly reported start, fenced by the caller. */
    readonly freshStart: () => TFreshStart | undefined;
  },
): WorkspaceSubmitWitness<TFreshStart> | undefined {
  if (newFormPendingCreateDrawn(frame)) return { kind: "pending-create", frame };
  const start = options.freshStart();
  if (start !== undefined) return { kind: "fresh-start", frame, start };
  if (completeNewFormDrawn(frame) && newFormWorkspaceValue(frame) === options.completedPath) {
    return { kind: "owned-folder-completion", frame, completedPath: options.completedPath };
  }
  return undefined;
}

/**
 * The only witness that may cause the one intended second Enter: the form is
 * still completely drawn and its field now holds the exact completed owned
 * folder. A pending create or a freshly reported start means the real host
 * already took the submission, so a further Enter would land in the child that
 * has taken input ownership and is never sent.
 */
export function requiresSecondWorkspaceEnter<T>(
  witness: WorkspaceSubmitWitness<T> | undefined,
): witness is Extract<WorkspaceSubmitWitness<T>, { kind: "owned-folder-completion" }> {
  return witness?.kind === "owned-folder-completion";
}
