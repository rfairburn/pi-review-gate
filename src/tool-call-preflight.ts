import { registerHook } from "./pi";
import { isToolCallFingerprint, toolCallFingerprint, type StartLiveness } from "./tool-call-fingerprint";

const CODEMODE_TOOL_NAME = "codemode";

const OWNED_NATIVE_TOOL_NAMES = new Set([
  "ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop",
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
]);

/** One correlated nested tool call (pi id `<parent tool call id>/<n>`). */
interface NestedCallRecord {
  id: string;
  parentToolCallId: string;
  name: string;
  fingerprint: string;
  position: number;
  admission?: "allowed" | "blocked";
  outcome: "unknown" | "success" | "error" | "blocked";
  started: boolean;
  returnedErrorObserved: boolean;
  executionStartObserved: boolean;
  retryAttempt: boolean;
  preflighted: boolean;
}

/**
 * Nested calls of one codemode parent, in preflight order. The fingerprint
 * set is the nested analogue of the direct per-batch duplicate set: each
 * prefighted nested call registers whether it was admitted or blocked.
 */
interface NestedTree {
  children: NestedCallRecord[];
  readonly seenFingerprints: Set<string>;
}

type NestedLineageCause = "unrooted" | "blocked" | "settled";

interface ToolCallMember {
  id?: string;
  name: string;
  input?: Record<string, unknown>;
  fingerprint?: string;
  position: number;
  admission?: "allowed" | "blocked";
  outcome: "unknown" | "success" | "error" | "blocked";
  started: boolean;
  returnedErrorObserved: boolean;
  retryAttempt: boolean;
  /** Pi emits tool_execution_start before this member's tool_call preflight. */
  executionStartObserved: boolean;
  /** Whole-batch fallback blocked this innocent sibling, not its submitted operation. */
  fallbackBlocked?: boolean;
  preflighted: boolean;
}

interface ToolCallGroup {
  members: ToolCallMember[];
  /** Known before prefights begin, so every member can be blocked in turn. */
  fallbackReason?: string;
  fallbackOffender?: { position: number; name: string };
  readonly seenFingerprints: Set<string>;
  fallbackPosition: number;
}

export interface NativeToolCallPreflightOptions {
  shellStartLiveness?: (fingerprint: string) => StartLiveness;
  subtaskStartLiveness?: (fingerprint: string) => StartLiveness;
}

/**
 * Native Pi assistant-tool-call guard. Pi finishes an assistant message, then
 * emits `tool_execution_start` before invoking the ordered `tool_call`
 * preflights for that message's members. The message is therefore the bounded
 * batch authority; operation results are paired by Pi's call id, and a start
 * event is not treated as execution until that member is admitted.
 */
export class NativeToolCallPreflight {
  private currentGroup: ToolCallGroup | undefined;
  private previousGroup: ToolCallGroup | undefined;
  private uncorrelatedCallsUntilMessageEnd = false;
  private readonly membersById = new Map<string, ToolCallMember>();
  private readonly nestedById = new Map<string, NestedCallRecord>();
  private readonly nestedTreesByRoot = new Map<string, NestedTree>();
  private readonly pendingNestedStarts = new Map<string, string>();

  constructor(private readonly options: NativeToolCallPreflightOptions = {}) {}

  /** Register every native lifecycle seam required by this guard, fail closed if any is absent. */
  registerLifecycleHooks(pi: unknown): boolean {
    const hooks = [
      registerHook(pi, "message_end", (...args) => this.onMessageEnd(args)),
      registerHook(pi, "tool_execution_start", (...args) => this.onExecutionStart(args)),
      registerHook(pi, "tool_result", (...args) => this.onToolResult(args)),
      registerHook(pi, "session_tree", () => this.reset()),
    ];
    return hooks.every(Boolean);
  }

  reset(): void {
    this.currentGroup = undefined;
    this.previousGroup = undefined;
    this.uncorrelatedCallsUntilMessageEnd = false;
    this.membersById.clear();
    this.nestedById.clear();
    this.nestedTreesByRoot.clear();
    this.pendingNestedStarts.clear();
  }

  /** Register the native preflight event with an optional composed observer. */
  registerToolCallHook(pi: unknown, observer: (...args: unknown[]) => unknown = (...args) => this.preflight(args)): boolean {
    return registerHook(pi, "tool_call", (...args) => observer(...args));
  }

  /** The return value is the native Pi `tool_call` preflight action, if blocked. */
  preflight(args: unknown[]): { block: true; reason: string } | undefined {
    const event = readToolCallEvent(args);
    if (event.parentToolCallId) {
      // Nested call (pi assigns `<parentToolCallId>/<n>` ids and never writes
      // them into the assistant transcript). Correlation and duplicate policy
      // only: the composed tool-call authority gates that run before this
      // preflight already covered this call, so a pass-through here neither
      // grants nor re-checks authority.
      return this.preflightNested(event);
    }
    const group = this.currentGroup;
    if (!group) {
      this.uncorrelatedCallsUntilMessageEnd = true;
      return {
        block: true,
        reason: this.uncorrelatedFallbackReason(event.name, 1),
      };
    }

    const member = this.findCurrentMember(group, event);
    if (this.uncorrelatedCallsUntilMessageEnd && !group.fallbackReason) {
      if (member) this.markBlocked(member);
      return {
        block: true,
        reason: this.runtimeCorrelationFailureReason(member, event.name),
      };
    }
    if (group.fallbackReason) {
      const blockedMember = member ?? this.fallbackMember(group);
      if (blockedMember) {
        if (group.fallbackOffender?.position === blockedMember.position) {
          this.markBlocked(blockedMember);
        } else {
          blockedMember.admission = "blocked";
          blockedMember.outcome = "blocked";
          blockedMember.fallbackBlocked = true;
        }
      }
      group.fallbackPosition += 1;
      return {
        block: true,
        reason: this.wholeGroupFallbackReason(group, blockedMember, event.name),
      };
    }

    if (!member || event.name !== member.name || !isToolCallFingerprint(member.fingerprint)) {
      // This is unreachable for Pi's ordered native event contract after a
      // well-formed message_end plan. The call id and tool name are the stable
      // correlation seam; Pi may normalize validated input (for example by
      // dropping submitted optional nulls) before this hook. Block this and
      // all remaining members; do not claim earlier decisions were revoked.
      this.uncorrelatedCallsUntilMessageEnd = true;
      if (member) this.markBlocked(member);
      return {
        block: true,
        reason: this.runtimeCorrelationFailureReason(member, event.name),
      };
    }
    if (member.preflighted) {
      this.uncorrelatedCallsUntilMessageEnd = true;
      this.markBlocked(member);
      return {
        block: true,
        reason: this.runtimeCorrelationFailureReason(member, event.name),
      };
    }

    member.preflighted = true;
    if (member.id) this.membersById.set(member.id, member);

    const duplicateInBatch = group.seenFingerprints.has(member.fingerprint);
    group.seenFingerprints.add(member.fingerprint);
    if (duplicateInBatch) {
      this.markBlocked(member);
      const earlierResultObserved = group.members.some((candidate) =>
        candidate.position < member.position
        && candidate.fingerprint === member.fingerprint
        && (candidate.outcome === "success" || candidate.outcome === "error"),
      );
      return {
        block: true,
        reason: this.targetedBlockReason(member, group, "same-batch", undefined, undefined, earlierResultObserved),
      };
    }

    const startStatus = this.startLiveness(member.name, member.fingerprint);
    if (startStatus.state === "active" || startStatus.state === "unknown") {
      this.markBlocked(member);
      return {
        block: true,
        reason: this.targetedBlockReason(member, group, startStatus.state, startStatus),
      };
    }

    const preceding = this.findPreviousMember(member.fingerprint);
    if (preceding) {
      if (preceding.outcome === "error" && preceding.started && !preceding.retryAttempt) {
        member.retryAttempt = true;
        this.markAllowed(member);
        return undefined;
      }
      this.markBlocked(member);
      const earlierResultObserved = preceding.outcome === "success" || preceding.outcome === "error";
      return {
        block: true,
        reason: this.targetedBlockReason(member, group, "previous-group", undefined, preceding, earlierResultObserved),
      };
    }

    this.markAllowed(member);
    return undefined;
  }

  /**
   * Correlate one nested tool call (issued by a running tool such as a
   * codemode script) with a live admitted codemode parent rooted in the
   * current assistant batch, then apply the same duplicate, retry, and
   * background-start liveness protections the direct native path applies.
   * Failures fail closed narrowly: they block only this nested call and never
   * poison unrelated model-issued batch members, earlier preflight decisions,
   * or other live scripts.
   */
  private preflightNested(event: ToolCallEvent): { block: true; reason: string } | undefined {
    const parentToolCallId = event.parentToolCallId!;

    const lineage = this.resolveNestedLineage(parentToolCallId);
    if (!lineage.ok) {
      return { block: true, reason: nestedCorrelationFailureReason(event.name, lineage.cause, parentToolCallId) };
    }

    const id = event.id;
    if (!isNestedChildCallId(id, parentToolCallId)) {
      return { block: true, reason: nestedChildIdShapeFailureReason(event.name) };
    }
    if (this.nestedById.has(id) || this.membersById.has(id)) {
      return { block: true, reason: duplicateNestedCallIdFailureReason(event.name) };
    }

    const input = event.input;
    const fingerprint = input ? toolCallFingerprint(event.name, input) : undefined;
    if (!event.name || !isRecord(input) || !isToolCallFingerprint(fingerprint)) {
      return { block: true, reason: unstableNestedIdentityFailureReason(event.name) };
    }

    const tree = this.ensureNestedTree(lineage.rootId);
    const record: NestedCallRecord = {
      id,
      parentToolCallId,
      name: event.name,
      fingerprint,
      position: tree.children.length + 1,
      outcome: "unknown",
      started: false,
      returnedErrorObserved: false,
      executionStartObserved: false,
      retryAttempt: false,
      preflighted: true,
    };
    tree.children.push(record);
    this.nestedById.set(id, record);

    // Pi emits the nested tool_execution_start before this preflight, so the
    // observed start arrives as pending evidence; admission marks the call
    // started exactly like the direct member path does.
    const pendingStartName = this.pendingNestedStarts.get(id);
    this.pendingNestedStarts.delete(id);
    if (pendingStartName === event.name) record.executionStartObserved = true;

    // Every prefighted nested call registers its fingerprint, blocked or
    // not, mirroring the direct per-batch set lifecycle.
    const duplicateInScript = tree.seenFingerprints.has(fingerprint);
    tree.seenFingerprints.add(fingerprint);

    // One liveness lookup serves both branches, mirroring the direct native
    // order (duplicates, then background-start checks, then predecessor
    // rules): active or unverifiable background-start work must not rerun,
    // including as the script's own retry after an observed failure.
    const startStatus = this.startLiveness(event.name, fingerprint);

    if (duplicateInScript) {
      if (startStatus.state === "active" || startStatus.state === "unknown") {
        this.markBlocked(record);
        return {
          block: true,
          reason: this.nestedDuplicateReason(record, startStatus.state, startStatus),
        };
      }
      const predecessor = precedingNestedRecord(tree, record);
      if (predecessor && predecessor.outcome === "error" && predecessor.started && !predecessor.retryAttempt) {
        record.retryAttempt = true;
        this.markAllowed(record);
        return undefined;
      }
      this.markBlocked(record);
      const earlierResultObserved = tree.children.some((candidate) =>
        candidate !== record
        && candidate.fingerprint === fingerprint
        && (candidate.outcome === "success" || candidate.outcome === "error"),
      );
      return {
        block: true,
        reason: this.nestedDuplicateReason(record, "same-script", undefined, predecessor, earlierResultObserved),
      };
    }

    if (startStatus.state === "active" || startStatus.state === "unknown") {
      this.markBlocked(record);
      return {
        block: true,
        reason: this.nestedDuplicateReason(record, startStatus.state, startStatus),
      };
    }

    this.markAllowed(record);
    return undefined;
  }

  /**
   * Walk a nested call's parentToolCallId up to a model-issued codemode call
   * in the current assistant batch. There is no fixed nesting ceiling: the
   * walk follows recorded evidence alone and terminates by structure — every
   * recorded nested id was validated as its parent id plus a "/<n>" suffix,
   * so each step up strictly shortens the traced id. A visited-id set fails
   * closed if a lineage could ever point back at an ancestor instead of
   * terminating, because a cyclic claim is not a rooted live lineage either.
   * Every recorded parent must be admitted and unsettled; anything unknown,
   * blocked, or already returned rejects.
   */
  private resolveNestedLineage(
    parentToolCallId: string,
  ): { ok: true; rootId: string } | { ok: false; cause: NestedLineageCause } {
    const group = this.currentGroup;
    if (!group) return { ok: false, cause: "unrooted" };
    const visited = new Set<string>([parentToolCallId]);
    let callerId = parentToolCallId;
    for (;;) {
      const record = this.nestedById.get(callerId);
      if (!record) break;
      if (record.admission === "blocked") return { ok: false, cause: "blocked" };
      if (record.outcome === "success" || record.outcome === "error") return { ok: false, cause: "settled" };
      // A nested parent must itself be live execution evidence.
      if (!record.started) return { ok: false, cause: "unrooted" };
      callerId = record.parentToolCallId;
      if (visited.has(callerId)) return { ok: false, cause: "unrooted" };
      visited.add(callerId);
    }
    const root = group.members.find((member) => member.id === callerId);
    if (!root) return { ok: false, cause: "unrooted" };
    if (root.admission !== "allowed") {
      return { ok: false, cause: root.admission === "blocked" ? "blocked" : "unrooted" };
    }
    if (root.outcome === "success" || root.outcome === "error") return { ok: false, cause: "settled" };
    if (!root.started || !isCodemodeScriptCall(root)) return { ok: false, cause: "unrooted" };
    return { ok: true, rootId: callerId };
  }

  private ensureNestedTree(rootId: string): NestedTree {
    let tree = this.nestedTreesByRoot.get(rootId);
    if (!tree) {
      tree = { children: [], seenFingerprints: new Set() };
      this.nestedTreesByRoot.set(rootId, tree);
    }
    return tree;
  }

  private nestedDuplicateReason(
    record: NestedCallRecord,
    cause: "same-script" | "active" | "unknown",
    status?: StartLiveness,
    predecessor?: NestedCallRecord,
    earlierResultObserved = false,
  ): string {
    const location = `nested call ${record.position} (${record.name}) in this codemode script`;
    let lead: string;
    if (record.name === "ShellStart" && cause === "active") {
      const identity = status?.state === "active" && status.identity ? ` ${status.identity}` : "";
      lead = `Duplicate ShellStart blocked: ${location} matches an earlier identical start with an active job${identity}; this call started no job.`;
    } else if (record.name === "ShellStart" && cause === "unknown") {
      lead = `Duplicate ShellStart blocked: ${location} could not verify whether an identical job is active; this call started no job.`;
    } else if (record.name === "SubtasksStart" && cause === "active") {
      const identity = status?.state === "active" && status.identity ? ` in execution ${status.identity}` : "";
      lead = `Duplicate SubtasksStart blocked: ${location} matches an earlier identical start with active work${identity}; this call created no group or tasks.`;
    } else if (record.name === "SubtasksStart" && cause === "unknown") {
      lead = `Duplicate SubtasksStart blocked: ${location} could not verify whether identical work is active; this call created no group or tasks.`;
    } else {
      // The script-scoped duplicate path mirrors the direct native wording in
      // the order the direct path prefers its causes.
      if (predecessor?.retryAttempt && predecessor.outcome === "error") {
        lead = `Duplicate ${record.name} blocked after repeated failures: ${location} follows two identical executions that failed; this call did not run.`;
      } else if (predecessor?.retryAttempt && predecessor.outcome === "success") {
        lead = `Repeated calls blocked: ${location} follows an identical execution that succeeded; this call did not run.`;
      } else if (predecessor?.admission === "blocked" || predecessor?.outcome === "blocked") {
        lead = `Duplicate ${record.name} blocked: ${location} follows an identical request that was blocked before execution; this call did not run.`;
      } else if (predecessor && predecessor.outcome === "unknown") {
        lead = `Duplicate ${record.name} blocked: ${location} matches an adjacent request whose execution outcome was not observed; this call did not run.`;
      } else {
        lead = `Duplicate ${record.name} blocked: ${location} matches an earlier identical request in this script; this call did not run.`;
      }
    }
    const nextStep = toolSpecificNextStep(record.name, earlierResultObserved);
    return nextStep ? `${lead} ${nextStep}` : lead;
  }

  /**
   * Return the exact message_end-submitted identity only for a call admitted
   * by its per-member native preflight. Native execute callbacks use this
   * narrow id/name lookup instead of re-hashing Pi's normalized params.
   */
  admittedSubmittedFingerprint(toolCallId: string, toolName: string): string | undefined {
    if (!toolCallId || !toolName) return undefined;
    const record = this.nestedById.get(toolCallId);
    if (record) {
      // Nested records are keyed by pi's parent-assigned id in this guard's
      // own namespace; their fingerprint is the validated nested event input.
      if (record.name !== toolName || record.admission !== "allowed") return undefined;
      return isToolCallFingerprint(record.fingerprint) ? record.fingerprint : undefined;
    }
    const member = this.membersById.get(toolCallId);
    if (!member || member.id !== toolCallId || member.name !== toolName || member.admission !== "allowed") return undefined;
    return isToolCallFingerprint(member.fingerprint) ? member.fingerprint : undefined;
  }

  /** Record an explicit isError:true returned by an admitted owned native tool. */
  observeReturnedError(toolCallId: string, toolName: string): void {
    if (!toolCallId || !OWNED_NATIVE_TOOL_NAMES.has(toolName)) return;
    const member = this.membersById.get(toolCallId);
    if (member && member.id === toolCallId && member.name === toolName && member.admission === "allowed" && member.started) {
      member.returnedErrorObserved = true;
      member.outcome = "error";
      return;
    }
    const record = this.nestedById.get(toolCallId);
    if (record && record.name === toolName && record.admission === "allowed" && record.started) {
      record.returnedErrorObserved = true;
      record.outcome = "error";
    }
  }

  private onMessageEnd(args: unknown[]): void {
    const message = findAssistantMessage(args);
    if (!message) return;

    const completed = this.currentGroup;
    this.previousGroup = undefined;
    this.currentGroup = undefined;
    this.uncorrelatedCallsUntilMessageEnd = false;
    // Nested evidence belongs to the batch now ending; every nested execution
    // settled before its results were finalized.
    this.nestedById.clear();
    this.nestedTreesByRoot.clear();
    this.pendingNestedStarts.clear();

    if (typeof message.content === "string") {
      this.membersById.clear();
      return;
    }
    if (!Array.isArray(message.content)) {
      // The native host normally supplies assistant content as an array. If it
      // does not, the next tool_call cannot be tied to a submitted batch.
      this.membersById.clear();
      this.uncorrelatedCallsUntilMessageEnd = true;
      return;
    }

    const calls = message.content.filter((item) => isRecord(item) && item.type === "toolCall");
    if (calls.length === 0) {
      this.membersById.clear();
      return;
    }

    const members: ToolCallMember[] = calls.map((item, index) => {
      const call = item as Record<string, unknown>;
      const name = typeof call.name === "string" && call.name.length > 0 ? call.name : "unknown tool";
      const input = isRecord(call.arguments) ? call.arguments : undefined;
      const fingerprint = input ? toolCallFingerprint(name, input) : undefined;
      const id = typeof call.id === "string" && call.id.length > 0 ? call.id : undefined;
      return {
        ...(id ? { id } : {}),
        name,
        ...(input ? { input } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        position: index + 1,
        outcome: "unknown",
        started: false,
        returnedErrorObserved: false,
        executionStartObserved: false,
        retryAttempt: false,
        preflighted: false,
      };
    });

    let fallbackReason: string | undefined;
    let fallbackOffender: ToolCallGroup["fallbackOffender"];
    const seenIds = new Set<string>();
    for (const member of members) {
      if (member.name === "unknown tool" || !member.id || !member.input || !member.fingerprint) {
        fallbackReason = "a submitted member lacked a stable call identity or safely comparable tool name and JSON arguments";
        fallbackOffender = { position: member.position, name: member.name };
        break;
      }
      if (member.id && seenIds.has(member.id)) {
        fallbackReason = "submitted members shared a call identity and could not be selected independently";
        fallbackOffender = { position: member.position, name: member.name };
        break;
      }
      if (member.id) seenIds.add(member.id);
    }

    const group: ToolCallGroup = {
      members,
      ...(fallbackReason ? { fallbackReason, fallbackOffender } : {}),
      seenFingerprints: new Set(),
      fallbackPosition: 0,
    };
    this.previousGroup = completed;
    this.currentGroup = group;
    this.membersById.clear();
    for (const member of [...(completed?.members ?? []), ...members]) {
      if (member.id) this.membersById.set(member.id, member);
    }
  }

  private onExecutionStart(args: unknown[]): void {
    const id = eventCallId(args);
    const name = eventToolName(args);
    if (!id || !name) return;
    const member = this.membersById.get(id);
    if (member) {
      if (member.name !== name || member.admission === "blocked") return;
      member.executionStartObserved = true;
      if (member.admission === "allowed") member.started = true;
      return;
    }
    const record = this.nestedById.get(id);
    if (record) {
      // A nested execution start may also arrive after its preflight record
      // exists; treat it like a direct member's start evidence.
      if (record.name !== name || record.admission === "blocked") return;
      record.executionStartObserved = true;
      if (record.admission === "allowed") record.started = true;
      return;
    }
    // Pi emits a nested tool_execution_start before the nested tool_call
    // preflight creates its record; keep the pending observation for the
    // nested preflight to consume.
    if (eventParentToolCallId(args)) this.pendingNestedStarts.set(id, name);
  }

  private onToolResult(args: unknown[]): { isError: true } | undefined {
    const id = eventCallId(args);
    if (!id) return;
    const member = this.membersById.get(id);
    const record = member ? undefined : this.nestedById.get(id);
    const tracked = member ?? record;
    const name = eventToolName(args);
    if (!tracked || (name !== undefined && name !== tracked.name) || tracked.admission === "blocked") return;
    if (!tracked.started) {
      // A preflight-start event alone is not execution evidence: this member
      // may have been blocked before its callback ran, so it never earns retry
      // entitlement without an admitted execution start.
      tracked.outcome = "unknown";
      return;
    }
    if (tracked.returnedErrorObserved) {
      // Pi's fulfilled execute path sets its wrapper isError flag to false and
      // drops the extension result's top-level isError. The execute callback
      // reports that structured flag directly, so this hook can normalize the
      // final Pi result without inferring from displayed text or changing details.
      tracked.outcome = "error";
      return { isError: true };
    }
    const isError = resultErrorFlag(args, id, tracked.name);
    if (isError === undefined) {
      if (tracked.outcome !== "error" && tracked.outcome !== "success") tracked.outcome = "unknown";
      return;
    }
    tracked.outcome = isError ? "error" : "success";
    return undefined;
  }

  private findCurrentMember(group: ToolCallGroup, event: ToolCallEvent): ToolCallMember | undefined {
    if (event.id) {
      const member = group.members.find((candidate) => candidate.id === event.id);
      if (member) return member;
      return undefined;
    }
    return undefined;
  }

  private fallbackMember(group: ToolCallGroup): ToolCallMember | undefined {
    return group.members[group.fallbackPosition] ?? group.members.find((member) => !member.preflighted);
  }

  private markBlocked(call: { admission?: "allowed" | "blocked"; outcome: "unknown" | "success" | "error" | "blocked"; started: boolean }): void {
    call.admission = "blocked";
    call.outcome = "blocked";
    call.started = false;
  }

  private markAllowed(call: { admission?: "allowed" | "blocked"; started: boolean; executionStartObserved: boolean }): void {
    call.admission = "allowed";
    if (call.executionStartObserved) call.started = true;
  }

  private findPreviousMember(fingerprint: string): ToolCallMember | undefined {
    const matching = this.previousGroup?.members.filter((member) =>
      member.fingerprint === fingerprint && !member.fallbackBlocked,
    ) ?? [];
    // If an identical member was actually admitted, prefer its observed result
    // over any later same-batch member that the guard itself blocked.
    return matching.find((member) => member.admission === "allowed") ?? matching[0];
  }

  private startLiveness(name: string, fingerprint: string): StartLiveness {
    // Admission reserves a launch before the execute callback can publish
    // background-work liveness. Share this protection across live scripts
    // and direct members, without sharing ordinary script duplicates.
    if ((name === "ShellStart" || name === "SubtasksStart") && [
      ...(this.currentGroup?.members ?? []),
      ...this.nestedById.values(),
    ].some((call) =>
      call.name === name
      && call.fingerprint === fingerprint
      && call.admission === "allowed"
      && call.outcome === "unknown",
    )) {
      return { state: "unknown" };
    }
    const lookup = name === "ShellStart"
      ? this.options.shellStartLiveness
      : name === "SubtasksStart"
        ? this.options.subtaskStartLiveness
        : undefined;
    if (!lookup) return name === "ShellStart" || name === "SubtasksStart"
      ? { state: "unknown" }
      : { state: "inactive" };
    try {
      const status = lookup(fingerprint);
      if (status?.state === "active" || status?.state === "unknown" || status?.state === "inactive") return status;
    } catch {
      // An inability to establish whether a background start is still live
      // must never make another spawn admissible.
    }
    return { state: "unknown" };
  }

  private targetedBlockReason(
    member: ToolCallMember,
    group: ToolCallGroup,
    cause: "same-batch" | "active" | "unknown" | "previous-group",
    status?: StartLiveness,
    preceding?: ToolCallMember,
    earlierResultObserved = false,
  ): string {
    const location = `member ${member.position} (${member.name}) of ${group.members.length}`;
    let lead: string;
    if (member.name === "ShellStart" && cause === "active") {
      const identity = status?.state === "active" && status.identity ? ` ${status.identity}` : "";
      lead = `Duplicate ShellStart blocked: ${location} matches an earlier start with an active job${identity}; this member started no job.`;
    } else if (member.name === "ShellStart" && cause === "unknown") {
      lead = `Duplicate ShellStart blocked: ${location} could not verify whether an identical job is active; this member started no job.`;
    } else if (member.name === "SubtasksStart" && cause === "active") {
      const identity = status?.state === "active" && status.identity ? ` in execution ${status.identity}` : "";
      lead = `Duplicate SubtasksStart blocked: ${location} matches an earlier identical start with active work${identity}; this member created no group or tasks.`;
    } else if (member.name === "SubtasksStart" && cause === "unknown") {
      lead = `Duplicate SubtasksStart blocked: ${location} could not verify whether identical work is active; this member created no group or tasks.`;
    } else {
      if (cause === "same-batch") {
        lead = `Duplicate ${member.name} blocked: ${location} matches an earlier identical request in this native batch; this member did not run.`;
      } else {
        lead = `Duplicate ${member.name} blocked: ${location} matches an identical request in the immediately preceding native tool group; this member did not run.`;
      }
      if (preceding?.retryAttempt && preceding.outcome === "error") {
        lead = `Duplicate ${member.name} blocked after repeated failures: ${location} follows two identical executions that failed; this member did not run.`;
      } else if (preceding?.retryAttempt && preceding.outcome === "success") {
        lead = `Repeated calls blocked: ${location} follows an identical execution that succeeded; this member did not run.`;
      } else if (preceding?.admission === "blocked" || preceding?.outcome === "blocked") {
        lead = `Duplicate ${member.name} blocked: ${location} follows an identical request that was blocked before execution; this member did not run.`;
      } else if (preceding && preceding.outcome === "unknown") {
        lead = `Duplicate ${member.name} blocked: ${location} matches an adjacent request whose execution outcome was not observed; this member did not run.`;
      }
    }
    const nextStep = toolSpecificNextStep(member.name, earlierResultObserved);
    return nextStep ? `${lead} ${nextStep}` : lead;
  }

  private wholeGroupFallbackReason(group: ToolCallGroup, member: ToolCallMember | undefined, eventName: string): string {
    const current = member
      ? `member ${member.position} (${member.name})`
      : `member ${group.fallbackPosition + 1} (${eventName || "unknown tool"})`;
    const offender = group.fallbackOffender
      ? ` Offending submission: member ${group.fallbackOffender.position} (${group.fallbackOffender.name}).`
      : "";
    const reason = group.fallbackReason ?? "the native batch could not be safely correlated";
    const nextStep = toolSpecificNextStep(member?.name ?? eventName, false);
    return `Tool group blocked before execution: ${current} could not be safely selected because ${reason}; all ${group.members.length} tool calls in this group were blocked before execution.${offender}${nextStep ? ` ${nextStep}` : ""}`;
  }

  private runtimeCorrelationFailureReason(member: ToolCallMember | undefined, eventName: string): string {
    const current = member
      ? `member ${member.position} (${member.name})`
      : `an unrecognized member (${eventName || "unknown tool"})`;
    const nextStep = toolSpecificNextStep(member?.name ?? eventName, false);
    return `Tool group blocked before execution: ${current} did not match the submitted native batch. This member and any remaining calls before the next assistant message are blocked; earlier preflight decisions were not revoked.${nextStep ? ` ${nextStep}` : ""}`;
  }

  private uncorrelatedFallbackReason(name: string, position: number): string {
    const nextStep = toolSpecificNextStep(name, false);
    return `Tool group blocked before execution: member ${position} (${name || "unknown tool"}) had no matching assistant batch. This call did not run; any other calls before the next assistant message_end will also be blocked.${nextStep ? ` ${nextStep}` : ""}`;
  }
}

interface ToolCallEvent {
  name: string;
  id?: string;
  parentToolCallId?: string;
  input?: Record<string, unknown>;
}

function readToolCallEvent(args: unknown[]): ToolCallEvent {
  let name = "";
  let id: string | undefined;
  let parentToolCallId: string | undefined;
  let input: Record<string, unknown> | undefined;
  for (const value of args) {
    if (!isRecord(value)) continue;
    if (!name && typeof value.toolName === "string") name = value.toolName;
    if (!name && typeof value.name === "string" && ("input" in value || "arguments" in value)) name = value.name;
    if (!id && typeof value.toolCallId === "string") id = value.toolCallId;
    if (!id && typeof value.callId === "string") id = value.callId;
    if (!id && typeof value.id === "string" && (typeof value.toolName === "string" || typeof value.name === "string")) id = value.id;
    if (!parentToolCallId && typeof value.parentToolCallId === "string" && value.parentToolCallId.length > 0) {
      parentToolCallId = value.parentToolCallId;
    }
    if (!input && isRecord(value.input)) input = value.input;
  }
  return {
    name,
    ...(id !== undefined ? { id } : {}),
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(input ? { input } : {}),
  };
}

const parentAssignedChildIdSuffixPattern = /^[1-9][0-9]*$/;

/** Pi assigns each nested call the id `<parent tool call id>/<n>`. */
function isNestedChildCallId(value: string | undefined, parentToolCallId: string): value is string {
  if (!value) return false;
  const prefix = `${parentToolCallId}/`;
  return value.startsWith(prefix) && parentAssignedChildIdSuffixPattern.test(value.slice(prefix.length));
}

/** Codemode's model-facing call: the validated `{ code: string }` script input. */
function isCodemodeScriptCall(member: ToolCallMember): boolean {
  if (member.name !== CODEMODE_TOOL_NAME || !member.input) return false;
  return typeof member.input.code === "string";
}

function precedingNestedRecord(tree: NestedTree, record: NestedCallRecord): NestedCallRecord | undefined {
  for (let index = tree.children.length - 2; index >= 0; index -= 1) {
    const candidate = tree.children[index]!;
    if (candidate.fingerprint === record.fingerprint) return candidate;
  }
  return undefined;
}

/** Bounded, printable display for an observed parent call id in feedback. */
function describeObservedCallId(value: string): string {
  const printable = value.replace(/[^\x20-\x7e]/g, "?");
  if (!printable) return "(unnamed)";
  return printable.length > 48 ? `"${printable.slice(0, 45)}..."` : `"${printable}"`;
}

function nestedSubject(toolName: string): string {
  return toolName ? `nested ${toolName} call` : "nested tool call";
}

function nestedCorrelationFailureReason(toolName: string, cause: NestedLineageCause, parentToolCallId: string): string {
  const parent = describeObservedCallId(parentToolCallId);
  let detail: string;
  switch (cause) {
    case "blocked":
      detail = `its parent tool call ${parent} was blocked before execution, so no script can issue further calls under it`;
      break;
    case "settled":
      detail = `its parent tool call ${parent} already returned a result, so no script can issue further calls under it`;
      break;
    default:
      detail = `its parent tool call ${parent} is not a live admitted codemode call in this assistant batch`;
      break;
  }
  return `Nested call blocked before execution: ${detail}; this ${nestedSubject(toolName)} did not run. Unrelated model-issued tool calls are unaffected.`;
}

function nestedChildIdShapeFailureReason(toolName: string): string {
  return `Nested call blocked before execution: this ${nestedSubject(toolName)}'s call id does not follow pi's parent-assigned "<parent tool call id>/<n>" shape, so it could not be safely correlated; the nested call did not run. Unrelated model-issued tool calls are unaffected.`;
}

function duplicateNestedCallIdFailureReason(toolName: string): string {
  return `Nested call blocked before execution: this ${nestedSubject(toolName)}'s call id is already tracked as another tool call; the nested call did not run. Unrelated model-issued tool calls are unaffected.`;
}

function unstableNestedIdentityFailureReason(toolName: string): string {
  return `Nested call blocked before execution: this ${nestedSubject(toolName)}'s tool name or arguments could not be reduced to a stable comparable identity; the nested call did not run. Unrelated model-issued tool calls are unaffected.`;
}
function findAssistantMessage(args: unknown[]): Record<string, unknown> | undefined {
  for (const value of args) {
    if (!isRecord(value)) continue;
    if (value.role === "assistant") return value;
    if (isRecord(value.message) && value.message.role === "assistant") return value.message;
  }
  return undefined;
}

function eventCallId(args: unknown[]): string | undefined {
  for (const value of args) {
    if (!isRecord(value)) continue;
    if (typeof value.toolCallId === "string") return value.toolCallId;
    if (typeof value.callId === "string") return value.callId;
  }
  return undefined;
}

function eventParentToolCallId(args: unknown[]): string | undefined {
  for (const value of args) {
    if (isRecord(value) && typeof value.parentToolCallId === "string" && value.parentToolCallId.length > 0) {
      return value.parentToolCallId;
    }
  }
  return undefined;
}

function eventToolName(args: unknown[]): string | undefined {
  for (const value of args) {
    if (isRecord(value) && typeof value.toolName === "string" && value.toolName) return value.toolName;
  }
  return undefined;
}

function resultErrorFlag(args: unknown[], toolCallId: string, toolName: string): boolean | undefined {
  for (const value of args) {
    if (!isRecord(value) || value.toolCallId !== toolCallId || value.toolName !== toolName) continue;
    if (typeof value.isError === "boolean") return value.isError;
  }
  return undefined;
}

function toolSpecificNextStep(name: string, earlierResultObserved: boolean): string | undefined {
  switch (name) {
    case "ShellStart":
    case "SubtasksStart":
      return undefined;
    case "SubtasksInspect":
      return "No inspection snapshot was taken by this member. Repeated polling is discouraged; rely on event-driven completion notifications, or use SubtasksWatch for one decision-relevant, one-shot callback while work continues.";
    case "ApplyPatch":
      return "Revalidate the intended patch against the current file contents and any prior patch outcome before making further edits.";
    case "bash":
    case "powershell":
      return "Review any existing command result and the current workspace state.";
    case "read":
    case "grep":
    case "find":
    case "ls":
    case "WebFetch":
    case "WebSearch":
      return earlierResultObserved ? "Use the returned result." : "This blocked member produced no result.";
    default:
      return "Use the evidence already available.";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
