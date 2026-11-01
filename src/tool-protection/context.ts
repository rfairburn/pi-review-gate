/**
 * Deterministic auditor-context assembly for the pre-execution tool-protection
 * gate (issue #536; the context-budget semantics are corrected by #590 and the
 * variable framing is compacted by #590/#595).
 *
 * Code, not a model, builds the request. `maxContextChars` bounds the
 * **variable context** only: the proposed call, the session evidence, and the
 * quoted governing instructions, together with the JSON structure and escaping
 * this module adds around them. The code-owned decision instruction, policy,
 * provenance and output blocks are unchanged at every assembly, are always
 * present, are printed ahead of any variable data, and are never charged against
 * that budget. The text actually sent to an auditor is therefore the fixed
 * instruction overhead plus at most `maxContextChars` of curated variable data;
 * the configured budget is never silently raised, and total evaluation input is
 * larger than the budget by that fixed overhead.
 *
 * A budget is not a reason to refuse a call. An oversized proposal, oversized
 * governing text, or an oversized session reaches the configured auditor with
 * the largest useful bounded context, and the actual returned PASS/FAIL decides
 * (issue #590). Only absent or malformed mandatory input is refused: with no
 * governing text and no reproducible proposal there is nothing to audit.
 *
 * The variable context is ONE minified JSON object, the same shape at every
 * budget, with readable field names and no section banners, per-record trust
 * prose, or end-of-section boilerplate:
 *
 *   {
 *     "quotedGoverningInstructions": {"source":…,"text":…,"partial":…},
 *     "evidence": [{"origin":…,"text":…,"partial":…,"id":…,"causal":…,
 *                   "invocationId":…,"createdAt":…}, …],   // newest first
 *     "proposedCall": {"tool":…,"arguments":…,"id":…,"cwd":…,"role":…,"task":…,
 *                      "lineage":…,"partial":…}
 *   }
 *
 * Only `proposedCall` is mandatory; a block the budget cannot hold is omitted
 * whole, and a record the budget can only partly hold carries its leading
 * portion with a structural `"partial":true`. `quotedGoverningInstructions` is
 * quoted data about the acting agent — never instructions to the auditor and
 * never user authorization — and `arguments` is a string holding the canonical
 * serialization of the submitted arguments, so a bounded portion is still valid
 * quoted JSON data and no second, unbudgeted copy of the arguments exists.
 *
 * The JSON structure is what carries the framing, and it is what keeps
 * provenance structural: every untrusted value sits inside a JSON string, so it
 * cannot close a quote, add a field, name an origin, or invent a record the host
 * did not record. Raw text could otherwise contain a header plus a rendered
 * record and read as a second host-labelled item — a quoted approval inside tool
 * output would read as genuine user evidence. The fixed provenance legend
 * printed ahead of this object already says what each recorded origin means and
 * what it can and cannot prove, so each record repeats only the origin the host
 * recorded for it.
 *
 * Selection order is fixed, deterministic, and independent of render order:
 *  1. the proposed invocation itself — the tool name and the leading submitted
 *     arguments, ahead of invocation identity, working directory, role and
 *     lineage, and ahead of the acting agent's (often much larger) governing
 *     prompt;
 *  2. surrounding session evidence, globally newest first regardless of origin
 *     or causal flag, so the message immediately before a proposal is retained
 *     ahead of older material;
 *  3. the optional facts about the invocation and about each selected record —
 *     id, causal marking, invocation reference, capture clock, working
 *     directory, role, task, lineage — allocated only after the quoted text of
 *     every selected record, one fact at a time, most useful first, and dropped
 *     whole when it does not fit;
 *  4. everything else previously supplied to the acting call, including the
 *     quoted governing instructions, only in the room that remains.
 * A record that does not fit whole contributes its leading portion and is marked
 * structurally, so capacity is never wasted by skipping a high-priority record
 * whole and older, less relevant data never takes the place of a newer one. A
 * record the host itself retained only in part arrives marked `partial` and is
 * never presented as a complete statement. Nothing is summarized by a second
 * model, no truncation notice is added to the request, and no request claims a
 * record is complete when it is not.
 *
 * The render order above is the cache-friendly one: every unchanged code-owned
 * block is printed first, then the selected governing reference, the selected
 * session evidence, and the proposed call last, which is the only part an
 * ordinary repeat of an audit changes. The fixed blocks are the unconditional
 * shared prefix: at one level they are the same bytes at every assembly,
 * whatever the proposal. The prefix reaches further only under a stronger
 * condition — two assemblies that select the same governing reference and the
 * same session records, with the same amount of each quoted, share those bytes
 * too and first differ inside the proposed call. A different proposal can change
 * what the budget selects, so a shared retained session does not by itself
 * promise a deeper shared prefix.
 *
 * Hidden model reasoning is never carried here.
 */

import type { ProtectionLevel } from "./config";
import { serializeProtectionAuditorEnvelope } from "./runner";
import {
  renderProtectionDecisionInstruction,
  renderProtectionOutputContract,
  renderProtectionPolicy,
  renderProtectionProvenanceNote,
  TOOL_PROTECTION_POLICY_VERSION,
} from "./policy";

/** Origin classification the host recorded for one evidence item. */
export const PROTECTION_EVIDENCE_ORIGINS = [
  "user",
  "gate",
  "assistant",
  "tool-result",
  "repository",
  "summary",
  "extension",
  "unknown",
  "system",
  "reasoning",
] as const;
export type ProtectionEvidenceOrigin = (typeof PROTECTION_EVIDENCE_ORIGINS)[number];

export interface ProtectionEvidence {
  /**
   * Stable host-supplied identity for the record. It is carried as an optional
   * lower-priority fact, after the quoted session text of every selected record
   * (#590), so a record's bookkeeping can never take the capacity that carries
   * another record's message.
   */
  id: string;
  origin: ProtectionEvidenceOrigin;
  /** Quoted as supplied data; only the leading portion is carried when it cannot fit. */
  text: string;
  /**
   * The host established a causal link to this proposal (its refusal, the acting
   * model's inability report, or the approval that followed). Causality is never
   * inferred from text matching here. It is rendered as a recorded fact; it does
   * not outrank recency in selection (#590).
   */
  causal?: boolean;
  /** For `gate` records: the invocation the recorded decision refers to. */
  invocationId?: string;
  /**
   * Host epoch milliseconds. The host uses it to merge evidence sources into one
   * chronology before handing them over; this module renders it as a fact and
   * takes the array order as that chronology.
   */
  createdAt?: number;
  /**
   * The host retained only the leading portion of this record, so its text is
   * not the whole original. It is rendered with the same structural `partial`
   * marker as a record this module bounded, so a retained prefix is never
   * presented as a complete statement.
   */
  partial?: true;
}

/** Identity of the exact call under audit. Rendered as facts, never widened. */
export interface ProtectionProposedCall {
  /** Stable identity of this proposal, not of a previous refused call. */
  invocationId: string;
  toolName: string;
  /** Submitted arguments as proposed; the leading portion is carried when they cannot fit. */
  args: unknown;
  cwd: string;
  /**
   * Host-supplied actor or role label (for example primary versus a delegated
   * worker kind). Reproduced verbatim as a fact; this module assigns it no
   * authority and interprets it no further.
   */
  role: string;
  taskId?: string;
  /** Nested lineage, outermost first. */
  lineage?: string[];
}

export interface ProtectionContextInput {
  /** Enabled level that selects the code-owned policy profile. */
  level: ProtectionLevel;
  /** The effective governing prompt for the acting call, quoted as reference material. */
  governingSystemPrompt: string;
  /** Where the governing prompt came from, e.g. the host accessor used. */
  governingPromptOrigin?: string;
  proposedCall: ProtectionProposedCall;
  /** Evidence oldest-first; array order is both the rendered chronology and the recency used for selection. */
  evidence?: readonly ProtectionEvidence[];
  /**
   * Variable-context budget in characters (UTF-16 code units): the proposed
   * call, session evidence, and governing reference material including the JSON
   * structure and escaping added around them. The unchanged fixed instruction
   * blocks sit outside this budget.
   */
  maxContextChars: number;
  /**
   * Present when the selected transport carries host metadata beside the
   * request text (the external auditor envelope). The builder then returns the
   * bounded `wireInput` and charges its size against `maxContextChars`, so the
   * budget covers everything the transport sends apart from the fixed
   * instruction blocks rather than only the request text. Omit it when the
   * transport carries the request text alone.
   */
  wire?: { argumentFingerprint?: string };
}

/** Why an evidence item is absent from the assembled request. */
export type ProtectionEvidenceOmissionReason =
  | "hidden-reasoning"
  | "governing-instructions-supplied-separately"
  | "duplicate-governing-prompt"
  | "budget";

export interface ProtectionEvidenceOmission {
  id: string;
  reason: ProtectionEvidenceOmissionReason;
}

export type ProtectionContextFailureCategory =
  /** A mandatory input is absent or unusable, so no fair audit exists. */
  | "missing-required-context";

export interface ProtectionContextPrompt {
  ok: true;
  /** Send this text to the selected auditor unchanged. */
  prompt: string;
  policyVersion: string;
  level: Exclude<ProtectionLevel, "off">;
  /**
   * Code units the transport carries for the bounded variable context inside
   * `prompt`: its JSON structure and escaping, plus the separator that attaches
   * it. This is the quantity `maxContextChars` bounds.
   */
  variableChars: number;
  /**
   * UTF-16 code units of the unchanged fixed instruction blocks. They are
   * always present and are outside the context budget, so a request is larger
   * than the budget by this amount.
   */
  fixedChars: number;
  /** `prompt.length`: fixed instruction overhead plus the bounded variable context. */
  promptChars: number;
  maxContextChars: number;
  /**
   * Code units the transport carries for `wireInput`, including the envelope
   * framing it shares with the request text, charged against the same budget as
   * `variableChars`, so `variableChars + wireChars` never exceeds
   * `maxContextChars`. Zero when no side payload is sent.
   */
  wireChars: number;
  /**
   * Bounded host metadata for the external auditor envelope: proposal identity
   * and selection counts, never a second copy of the submitted arguments or
   * governing text. Returned only when the caller asked for it with `wire`.
   */
  wireInput?: ProtectionWireInput;
  /** Retained evidence ids newest-first, matching the request. */
  includedEvidenceIds: string[];
  /** Causal evidence ids the host supplied for this proposal, whether retained or not. */
  requiredEvidenceIds: string[];
  omittedEvidence: ProtectionEvidenceOmission[];
}

/**
 * What the external auditor envelope carries beside the request text. Every
 * value is host-recorded and bounded, and the whole object is counted against
 * the context budget; when even the bounded identity does not fit the share of
 * the budget a side payload may take, the identity is dropped and only the
 * fixed-shape fields remain.
 */
export interface ProtectionWireInput {
  version: "pi-tool-protection-input-v2";
  policyVersion: string;
  level: Exclude<ProtectionLevel, "off">;
  invocation?: {
    invocationId: string;
    toolName: string;
    argumentFingerprint?: string;
  };
  context: {
    maxContextChars: number;
    evidenceIncluded: number;
    evidenceOmitted: number;
  };
}

export interface ProtectionContextFailure {
  ok: false;
  category: ProtectionContextFailureCategory;
  /** Honest diagnostic for the acting model and the user; the call did not run. */
  message: string;
  maxContextChars: number;
}

export type ProtectionContextResult = ProtectionContextPrompt | ProtectionContextFailure;

/** The blank line that attaches the variable context to the fixed blocks. */
const VARIABLE_SEPARATOR = "\n\n";

/** The one quoted-reference block: the governing instructions of the acting call. */
type GoverningData = {
  source: string;
  text: string;
  partial?: true;
};

/** One session record: the origin the host recorded, its quoted text, then its own facts. */
type EvidenceData = {
  origin: ProtectionEvidenceOrigin;
  text: string;
  partial?: true;
  id?: string;
  causal?: true;
  invocationId?: string;
  createdAt?: number;
};

/** The exact call under audit. `arguments` is the canonical serialization, quoted as data. */
type ProposedCallData = {
  tool: string;
  arguments: string;
  id?: string;
  cwd?: string;
  role?: string;
  task?: string;
  lineage?: readonly string[];
  partial?: true;
};

/** The whole variable context: one minified JSON object in this key order. */
type ContextData = {
  quotedGoverningInstructions?: GoverningData;
  evidence?: EvidenceData[];
  proposedCall: ProposedCallData;
};

/** One optional host fact about an invocation or a record, in allocation order. */
interface ContextFact {
  key: string;
  value: string | number | boolean | readonly string[];
}

/** One block being filled: its quoted text plus the facts accepted for it so far. */
interface ContextSlot {
  /** The quoted data itself — submitted arguments, session text, or governing text. */
  text: string;
  /** Only a leading portion of what was supplied is carried. */
  bounded: boolean;
  /** Facts accepted so far, in allocation order. */
  facts: ContextFact[];
  /** Every fact the host supplied, in allocation order: most useful first. */
  availableFacts: readonly ContextFact[];
}

/** Evidence carrying its position in the host-supplied array, oldest first. */
interface OrderedEvidence extends ProtectionEvidence {
  order: number;
}

interface EvidenceSlot extends ContextSlot {
  item: OrderedEvidence;
}

interface CallSlot extends ContextSlot {
  tool: string;
}

/** The allocation state for one assembly: what has been given capacity so far. */
interface ContextPlan {
  governing?: { source: string; slot: ContextSlot };
  evidence: EvidenceSlot[];
  call: CallSlot;
}

/**
 * Build the complete auditor request for one proposal.
 *
 * The variable context is bounded to `maxContextChars` by selection and, where a
 * record cannot fit whole, by carrying its leading portion; the fixed
 * instruction blocks are always included and are outside that budget. Returns an
 * `ok: false` result only when a fair audit is impossible because mandatory
 * input is absent or unusable: the caller must treat that as fail closed and
 * must not truncate further, summarize with a model, switch auditor, or run the
 * tool.
 *
 * @throws {Error} for a caller mistake: level `off` audits nothing, a
 * non-positive or non-integer budget, or a malformed evidence record.
 */
export function buildProtectionContext(input: ProtectionContextInput): ProtectionContextResult {
  if (input.level === "off") {
    throw new Error("buildProtectionContext requires an enabled protection level; \"off\" audits nothing");
  }
  const maxContextChars = input.maxContextChars;
  if (typeof maxContextChars !== "number" || !Number.isSafeInteger(maxContextChars) || maxContextChars <= 0) {
    throw new Error("buildProtectionContext requires a positive whole-number maxContextChars");
  }
  const governingSystemPrompt = input.governingSystemPrompt;
  if (typeof governingSystemPrompt !== "string" || governingSystemPrompt.trim().length === 0) {
    return failure("missing-required-context", maxContextChars,
      "Tool protection could not audit this call: the governing system instructions for the acting call were not supplied. Nothing was substituted and no fallback auditor was used; the proposed call was not run.");
  }
  const call = input.proposedCall;
  const renderedCall = renderProposedCall(call);
  if (!renderedCall.ok) {
    return failure("missing-required-context", maxContextChars,
      `Tool protection could not audit this call: ${renderedCall.problem}. The proposed call cannot be reproduced, so no fair audit exists and the proposed call was not run.`);
  }

  const { evidence, requiredIds, omissions } = partitionEvidence(input.evidence ?? [], governingSystemPrompt);

  // A transport that carries host metadata beside the request text pays for it out
  // of the same budget. The share below is only the ceiling that optional metadata
  // may take; what selection actually gives up is the built object's serialized cost,
  // measured with the same serializer the transport uses so the envelope framing is
  // included, so the request text and the side payload together never exceed
  // `maxContextChars` without leaving a large unused allocation.
  const wireCeiling = input.wire === undefined ? 0 : Math.floor(maxContextChars / WIRE_METADATA_BUDGET_RATIO);
  // The side payload is the one authoritative metadata object, built before any
  // context is selected with count widths that can only shrink: the included count
  // cannot exceed the number of candidate records, and the omitted count cannot
  // exceed those candidates plus the omissions already recorded. Selection gives up
  // its actual serialized cost — including the envelope framing it shares with the
  // request text — and never the ceiling, so no capacity is left idle; the counts are
  // then updated in place.
  const wireInput = input.wire === undefined ? undefined : buildWireInput(
    input.level,
    renderedCall.tool,
    renderedCall.invocationId,
    input.wire.argumentFingerprint,
    wireCeiling,
    {
      maxContextChars,
      evidenceIncluded: evidence.length,
      evidenceOmitted: omissions.length + evidence.length,
    },
  );
  const wireReservation = wireInput === undefined ? 0 : serializeProtectionAuditorEnvelope("", wireInput).length;

  // Fixed blocks: unchanged at every assembly, outside the context budget, and
  // all of them printed before any variable data. The instruction block is
  // level-aware: `dangerous` applies the two harms plus an applicable explicit
  // prohibition from a genuine current-session user message, but not general
  // governing-instruction conformance (#542, corrected by #545). Fail-closed
  // mechanics live in code, not in this text, and are identical at every level.
  // No invocation id, count, or timestamp is rendered ahead of this prefix, so it
  // is the stable leading material of the request.
  const fixed = [
    `TOOL PROTECTION - PRE-EXECUTION AUDIT REQUEST (policy version ${TOOL_PROTECTION_POLICY_VERSION})`,
    renderProtectionDecisionInstruction(input.level),
    renderProtectionPolicy(input.level),
    `EVIDENCE PROVENANCE\n${renderProtectionProvenanceNote()}`,
    `OUTPUT CONTRACT\n${renderProtectionOutputContract()}`,
  ];

  // One fill pass in strict priority order, each block claiming only the room the
  // higher-priority blocks left. `room` is the whole allowance for this assembly,
  // so every step measures the cost of the object as built so far against it. The
  // proposal's own identity facts are held out of the leading step: the priority
  // puts the tool name and the leading submitted arguments ahead of invocation ids,
  // working directory, role, and lineage. Session records are filled the same way:
  // their quoted text is selected first across the whole array, and each record's
  // id, causal marking, invocation reference, and capture clock are attached
  // afterwards from the room that leaves, never ahead of another record's message.
  // The quoted governing reference is the last material filled, so identity facts
  // take the room the proposal and all selected session-message content left. A
  // block that is about to be bounded is marked before its quote is searched, so
  // the structural marker is paid for by the quote that caused it and the reported
  // accounting stays exact.
  const room = maxContextChars - wireReservation;
  const plan: ContextPlan = {
    evidence: [],
    call: { tool: renderedCall.tool, text: renderedCall.args, bounded: false, facts: [], availableFacts: renderedCall.facts },
  };

  let usable = true;
  if (contextChars(plan) > room) {
    // 1. The proposed operation and its leading submitted arguments. When not
    //    even the mandatory block with a nonempty quote fits, nothing is sent as
    //    an empty shell, and the size of the proposal is still not a refusal
    //    ground (issue #590).
    plan.call.bounded = true;
    usable = longestQuotedText(plan, plan.call, room) > 0;
    if (!usable) plan.call.bounded = false;
  }
  if (usable) {
    // 2. Session evidence, globally newest first, whatever its origin or causal
    //    flag: the message immediately before the proposal outranks older
    //    material, and the next-oldest record contributes a leading portion
    //    instead of being skipped whole (#590).
    for (let index = evidence.length - 1; index >= 0; index -= 1) {
      const item = evidence[index]!;
      const slot: EvidenceSlot = {
        item,
        text: item.text,
        bounded: item.partial === true,
        facts: [],
        availableFacts: evidenceFacts(item),
      };
      plan.evidence.push(slot);
      if (contextChars(plan) <= room) continue;
      slot.bounded = true;
      // A quote carrying no original text is not worth a record's structure.
      if (longestQuotedText(plan, slot, room) === 0) plan.evidence.pop();
      break;
    }
    // 3. The optional facts of the selected records and of the proposal, one fact
    //    at a time, most useful first, only from the room the quoted text left. A
    //    fact that does not fit is dropped rather than shortening a quote or
    //    evicting an older record.
    for (const slot of plan.evidence) acceptFacts(plan, slot, room);
    acceptFacts(plan, plan.call, room);
    // 4. The quoted governing reference, with only the room everything else left.
    const governingSlot: ContextSlot = { text: governingSystemPrompt, bounded: false, facts: [], availableFacts: [] };
    plan.governing = { source: input.governingPromptOrigin ?? "host-supplied, origin not stated", slot: governingSlot };
    if (contextChars(plan) > room) {
      governingSlot.bounded = true;
      if (longestQuotedText(plan, governingSlot, room) === 0) delete plan.governing;
    }
  }

  const variableBlock = usable ? JSON.stringify(contextData(plan)) : "";

  const includedEvidenceIds = plan.evidence.map((slot) => slot.item.id);
  const includedIds = new Set(includedEvidenceIds);
  const omittedEvidence: ProtectionEvidenceOmission[] = [...omissions];
  evidence.forEach((item) => {
    if (!includedIds.has(item.id)) omittedEvidence.push({ id: item.id, reason: "budget" });
  });

  if (wireInput !== undefined) {
    wireInput.context.evidenceIncluded = includedEvidenceIds.length;
    wireInput.context.evidenceOmitted = omittedEvidence.length;
  }
  const wireChars = wireInput === undefined ? 0 : serializeProtectionAuditorEnvelope("", wireInput).length;

  // The budget is charged in the code units the transport carries, including the
  // separator that attaches the variable context to the fixed blocks. The fixed
  // blocks are reported at their own unchanged text size, which is what they add
  // to the request, so `fixedChars` is the same at every budget and every
  // proposal, and the native split that uses it stays exact.
  const variableChars = variableBlock.length > 0 ? escapedUnits(`${VARIABLE_SEPARATOR}${variableBlock}`) : 0;
  const variableTextChars = variableBlock.length > 0 ? variableBlock.length + VARIABLE_SEPARATOR.length : 0;
  const prompt = [...fixed, ...(variableBlock.length > 0 ? [variableBlock] : [])].join(VARIABLE_SEPARATOR);
  return {
    ok: true,
    prompt,
    policyVersion: TOOL_PROTECTION_POLICY_VERSION,
    level: input.level,
    variableChars,
    fixedChars: prompt.length - variableTextChars,
    promptChars: prompt.length,
    maxContextChars,
    wireChars,
    ...(wireInput === undefined ? {} : { wireInput }),
    // Newest first, matching the rendered array.
    includedEvidenceIds,
    requiredEvidenceIds: requiredIds,
    omittedEvidence,
  };
}

/** How much of the context budget the external envelope's metadata may take. */
const WIRE_METADATA_BUDGET_RATIO = 3;

/**
 * Build the external envelope's side metadata under `ceiling` code units. The
 * proposal identity is bounded and is dropped whole when it cannot fit, so the
 * envelope never carries an unbudgeted copy of host identifiers and never
 * carries the submitted arguments or governing text: the request text is the one
 * authoritative copy of that data.
 */
function buildWireInput(
  level: Exclude<ProtectionLevel, "off">,
  toolName: string,
  invocationId: string,
  argumentFingerprint: string | undefined,
  ceiling: number,
  counts: ProtectionWireInput["context"],
): ProtectionWireInput {
  const base: ProtectionWireInput = {
    version: "pi-tool-protection-input-v2",
    policyVersion: TOOL_PROTECTION_POLICY_VERSION,
    level,
    context: counts,
  };
  // Identity is added one bounded field at a time, most useful first, so a long
  // host identifier costs only the fields it displaces rather than the whole
  // identity block, and the envelope never carries an unbudgeted identifier.
  const steps: Array<ProtectionWireInput> = [
    { ...base, invocation: { invocationId: fact(invocationId), toolName } },
    ...(argumentFingerprint === undefined
      ? []
      : [{ ...base, invocation: { invocationId: fact(invocationId), toolName, argumentFingerprint: fact(argumentFingerprint) } }]),
  ];
  let best = base;
  for (const step of steps) {
    if (serializeProtectionAuditorEnvelope("", step).length > ceiling) break;
    best = step;
  }
  return best;
}

function partitionEvidence(
  evidence: readonly ProtectionEvidence[],
  governingSystemPrompt: string,
): {
  evidence: OrderedEvidence[];
  requiredIds: string[];
  omissions: ProtectionEvidenceOmission[];
} {
  const items: OrderedEvidence[] = [];
  const requiredIds: string[] = [];
  const omissions: ProtectionEvidenceOmission[] = [];
  const seen = new Set<string>();
  evidence.forEach((item, index) => {
    const id = typeof item?.id === "string" && item.id.trim().length > 0 ? item.id : `evidence-${index + 1}`;
    if (typeof item?.text !== "string") {
      throw new Error(`buildProtectionContext evidence "${id}" requires a string text value`);
    }
    if (item.origin === "reasoning") {
      // Hidden reasoning is never shown to an auditor, and its exclusion is
      // disclosed to the caller rather than silently dropped.
      omissions.push({ id, reason: "hidden-reasoning" });
      return;
    }
    if (item.origin === "system") {
      omissions.push({ id, reason: "governing-instructions-supplied-separately" });
      return;
    }
    if (item.text === governingSystemPrompt) {
      omissions.push({ id, reason: "duplicate-governing-prompt" });
      return;
    }
    if (item.text.trim().length === 0 || seen.has(id)) return;
    seen.add(id);
    items.push({ ...item, id, order: index });
    if (item.causal === true) requiredIds.push(id);
  });
  return { evidence: items, requiredIds, omissions };
}

/**
 * The facts a session record carries, in allocation order: its own id, the
 * host's causal marking, the invocation a gate record names, and its capture
 * clock. Origin stays mandatory on the record itself, because a quoted message
 * without the origin the host recorded for it would be indistinguishable from
 * another origin's text; everything below is optional and can never be quoted
 * ahead of another record's message (#590).
 */
function evidenceFacts(item: ProtectionEvidence): ContextFact[] {
  return [
    { key: "id", value: fact(item.id) },
    ...(item.causal === true ? [{ key: "causal", value: true }] : []),
    ...(item.invocationId !== undefined && item.invocationId.trim().length > 0 ? [{ key: "invocationId", value: fact(item.invocationId) }] : []),
    ...(item.createdAt !== undefined ? [{ key: "createdAt", value: item.createdAt }] : []),
  ];
}

/**
 * One host-recorded identity fact. These label records; the authoritative text
 * is always the quoted data, so a fact is kept to a leading portion instead of
 * being able to consume the whole variable budget.
 */
const MAX_IDENTITY_FACT_CHARS = 256;

function fact(value: string): string {
  if (value.length <= MAX_IDENTITY_FACT_CHARS) return value;
  let end = MAX_IDENTITY_FACT_CHARS;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(end) >= 0xdc00 && value.charCodeAt(end) <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * Give `slot` its optional facts, in allocation order, from the room that is
 * left once every selected record's quoted text is carried. Each fact is taken
 * whole or dropped whole, so one record's bookkeeping is never quoted ahead of
 * an older record's message and never shortens a quote. Only accepted fields remain in the slot.
 */
function acceptFacts(plan: ContextPlan, slot: ContextSlot, room: number): void {
  for (const item of slot.availableFacts) {
    slot.facts.push(item);
    if (contextChars(plan) > room) slot.facts.pop();
  }
}

/**
 * The longest leading portion of `slot.text` that keeps the whole variable
 * context inside `limit`, leaving no split surrogate pair. The search measures
 * the cost of the whole object as the transport carries it, not the cost of the
 * text alone: the quoted data sits inside JSON that is itself escaped again when
 * it travels, so quotes and backslashes cost twice and only the serialized
 * object is a truthful measure. Returns the number of code units kept, which is
 * zero when no nonempty quote fits.
 */
function longestQuotedText(plan: ContextPlan, slot: ContextSlot, limit: number): number {
  const full = slot.text;
  let low = 0;
  let high = full.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    slot.text = full.slice(0, safeCut(full, middle));
    if (contextChars(plan) <= limit) low = middle;
    else high = middle - 1;
  }
  slot.text = full.slice(0, safeCut(full, low));
  return slot.text.length;
}

/**
 * The variable context for one allocation state, as one JSON object. Key order
 * is the render order, not the allocation order: the selected governing
 * reference leads, then the session records newest-first, then the proposed
 * call. Only the fixed instructions are unconditionally stable between audits;
 * deeper shared prefixes depend on identical selected variable data. Inside a
 * record the mandatory classification field leads, then the quoted data, then
 * the structural marker qualifying that data, then the optional host facts, so
 * what is being proposed is what the budget protects first, no bookkeeping field
 * is an indivisible prerequisite for the operation or for another record's
 * message, and a record that goes from whole to bounded keeps the bytes ahead of
 * its quoted data identical.
 */
function contextData(plan: ContextPlan): ContextData {
  const blocks: Record<string, unknown> = {};
  const governing = plan.governing;
  if (governing !== undefined) {
    const reference: GoverningData = {
      source: governing.source,
      text: governing.slot.text,
      ...(governing.slot.bounded ? { partial: true } : {}),
    };
    blocks.quotedGoverningInstructions = reference;
  }
  if (plan.evidence.length > 0) {
    blocks.evidence = plan.evidence.map((slot) => {
      const record: EvidenceData = {
        origin: slot.item.origin,
        text: slot.text,
        ...(slot.bounded ? { partial: true } : {}),
      };
      return withFacts(record, slot.facts);
    });
  }
  const call: ProposedCallData = { tool: plan.call.tool, arguments: plan.call.text };
  const callBlock = withFacts(call, plan.call.facts);
  // The structural marker qualifying the quoted arguments comes after the
  // optional facts, so going from whole to bounded changes nothing ahead of the
  // quote itself.
  if (plan.call.bounded) callBlock.partial = true;
  blocks.proposedCall = callBlock;
  return blocks as ContextData;
}

/**
 * A block's mandatory fields followed by the facts it was given capacity for,
 * in allocation order. Facts are separate JSON fields, so a long host
 * identifier costs only the field it displaces rather than a whole wrapper of
 * bookkeeping, and no fact is an indivisible prerequisite for the quoted data.
 */
function withFacts(base: Record<string, unknown>, facts: readonly ContextFact[]): Record<string, unknown> {
  const record = { ...base };
  for (const item of facts) record[item.key] = item.value;
  return record;
}

/**
 * Code units the whole variable context contributes to the transport budget: the
 * separator that attaches it plus the serialized object, counted exactly as the
 * assembled request counts it. JSON escaping is per code unit, so these costs
 * add up across structure and records the way the serialized request does.
 */
function contextChars(plan: ContextPlan): number {
  return escapedUnits(VARIABLE_SEPARATOR) + escapedUnits(JSON.stringify(contextData(plan)));
}

/**
 * Code units one string contributes once the transport carries it. Escaping is
 * per code unit, so these costs add up across framing and records exactly as the
 * serialized request does, and a cut never splits a pair (see `safeCut`).
 */
function escapedUnits(value: string): number {
  return JSON.stringify(value).length - 2;
}

/**
 * A cut position that never splits a non-BMP character. Escaping a lone
 * surrogate costs six characters where the whole pair costs two, so a cut that
 * split a pair would both misreport the length and quote back an escape the host
 * never sent. Treating a splitting cut as the position before it keeps the
 * search monotone and the sent text well-formed.
 */
function safeCut(text: string, cut: number): number {
  if (cut > 0 && cut < text.length
    && isHighSurrogate(text.charCodeAt(cut - 1)) && isLowSurrogate(text.charCodeAt(cut))) {
    return cut - 1;
  }
  return cut;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * The proposed call as mandatory leading data plus optional identity facts. The
 * mandatory block names the operation and carries the canonical serialization of
 * the submitted arguments as quoted data. The invocation identity, working
 * directory, role, task, and lineage are optional facts carried after them and
 * bounded individually, so a long host identifier can never displace the
 * operation or its arguments from the budget (#590).
 */
function renderProposedCall(
  call: ProtectionProposedCall | undefined,
): { ok: true; tool: string; args: string; invocationId: string; facts: ContextFact[] } | { ok: false; problem: string } {
  if (!call) return { ok: false, problem: "the proposed invocation was not supplied" };
  if (typeof call.toolName !== "string" || call.toolName.trim().length === 0) {
    return { ok: false, problem: "the proposed tool name was not supplied" };
  }
  if (typeof call.invocationId !== "string" || call.invocationId.trim().length === 0) {
    return { ok: false, problem: "the invocation identity of the proposal was not supplied" };
  }
  let args: string;
  try {
    args = call.args === undefined ? "null (the proposal carried no arguments value)" : JSON.stringify(call.args) ?? "null";
  } catch {
    return { ok: false, problem: "the proposed arguments are not serializable, so the proposed call cannot be reproduced" };
  }
  const lineage = Array.isArray(call.lineage)
    ? call.lineage.filter((segment) => typeof segment === "string" && segment.trim().length > 0).map((segment) => fact(segment))
    : [];
  const facts: ContextFact[] = [
    { key: "id", value: fact(call.invocationId) },
    ...(typeof call.cwd === "string" && call.cwd.trim().length > 0 ? [{ key: "cwd", value: fact(call.cwd) }] : []),
    ...(typeof call.role === "string" && call.role.trim().length > 0 ? [{ key: "role", value: fact(call.role) }] : []),
    ...(call.taskId !== undefined && call.taskId.trim().length > 0 ? [{ key: "task", value: fact(call.taskId) }] : []),
    // Nested lineage travels outermost first as one fact, so a partial lineage is
    // never presented as the whole chain.
    ...(lineage.length > 0 ? [{ key: "lineage", value: lineage }] : []),
  ];
  return { ok: true, tool: fact(call.toolName), args, invocationId: call.invocationId, facts };
}

function failure(
  category: ProtectionContextFailureCategory,
  maxContextChars: number,
  message: string,
): ProtectionContextFailure {
  return { ok: false, category, message, maxContextChars };
}
