/**
 * Harness-owned worker contract (#760).
 *
 * One definition per subtask kind of what the harness itself requires of the
 * worker: verification expectations, the required final-report sections,
 * side-effect disclosure, and continuation/correction rules. The worker prompt
 * builders and the reviewer request builders both render their text from this
 * definition, so the worker and its reviewer always see the same contract and
 * the two cannot drift apart.
 *
 * The contract describes required behavior only. It never makes a worker
 * claim into evidence, and it never relaxes fail-closed evidence requirements:
 * a reviewer may still block when the evidence does not establish the
 * required outcome.
 */

export type WorkerContractKind = "execute" | "research" | "inplace";

export interface WorkerContract {
  kind: WorkerContractKind;
  /** Verification the harness requires of the worker. */
  verification: string;
  /** The final-report sections the harness requires. */
  report: string;
  /** Side-effect disclosure, when the kind can perform side effects. */
  sideEffects?: string;
  /** How continuation and correction turns relate to completed work. */
  continuation: string;
}

/**
 * Precedence between the task text and the harness contract. Worker and
 * reviewer see this exact wording.
 */
export const WORKER_CONTRACT_PRECEDENCE = "Precedence: output instructions in the task text (for example a requested format, length, or \"stop after\" instruction) govern the content and length of the result the worker leads with. The harness-required report sections and read-only verification in this contract still apply after that leading result and do not violate those instructions. A real conflict that this rule cannot resolve is a non_blocking observation, never a blocking finding.";

/**
 * Correction-loop rule shared by every kind: how reviewer recommendations
 * relate to "do not repeat completed work". Worker and reviewer see this exact
 * wording, and continuation prompts repeat it.
 */
export const WORKER_CORRECTION_RULE = "Corrections: on a continuation or correction turn, apply only what the instruction or the blocking findings require and do not repeat or undo completed work. Satisfy a finding about the report alone (its form, wording, length, or a missing or incorrect section) by returning a corrected report. Re-execute completed work only when a finding names a required outcome that the evidence does not establish.";

const IMPLEMENTATION_VERIFICATION = "Verification: run verification relevant to the change; targeted checks are expected. Read-only inspection that supports an acceptance criterion (for example confirming that no files changed) is verification, not extra work.";

const CONTRACTS: Readonly<Record<WorkerContractKind, WorkerContract>> = {
  execute: {
    kind: "execute",
    verification: IMPLEMENTATION_VERIFICATION,
    report: "Final report: when finished, summarize changed files, verification performed, and remaining risks.",
    continuation: WORKER_CORRECTION_RULE,
  },
  inplace: {
    kind: "inplace",
    verification: IMPLEMENTATION_VERIFICATION,
    report: "Final report: when finished, summarize exactly what you changed in this workspace, the verification you ran, and remaining risks. Do not claim review acceptance: the reviewer reports separately.",
    sideEffects: "Side effects: the final report also discloses every external side effect performed, including writes outside the workspace, network or API actions, and processes started.",
    continuation: WORKER_CORRECTION_RULE,
  },
  research: {
    kind: "research",
    verification: "Verification: support each conclusion with inspected repository or external evidence and note uncertainty or stale-snapshot risk. Read-only inspection is the expected method; do not modify the workspace.",
    report: "Final report: when finished, return a concise, source-linked report that addresses every acceptance criterion. Begin with one `Summary:` line of at most 240 characters that can stand alone in a parent completion notification; put supporting detail after it. Cite repository paths and external URLs directly. Do not cite child-local evidence IDs.",
    continuation: WORKER_CORRECTION_RULE,
  },
};

/** The contract kind for an isolated worktree task; in-place builders use "inplace" directly. */
export function workerContractKindFor(task: { backgroundKind?: string }): Exclude<WorkerContractKind, "inplace"> {
  return task.backgroundKind === "research" ? "research" : "execute";
}

export function workerContract(kind: WorkerContractKind): WorkerContract {
  return CONTRACTS[kind];
}

/**
 * The contract body both the worker prompt and the reviewer request carry,
 * byte for byte. Tests compare these lines across both builders.
 */
export function workerContractLines(kind: WorkerContractKind): string[] {
  const contract = workerContract(kind);
  return [
    `- ${contract.verification}`,
    `- ${contract.report}`,
    ...(contract.sideEffects ? [`- ${contract.sideEffects}`] : []),
    `- ${WORKER_CONTRACT_PRECEDENCE}`,
    `- ${contract.continuation}`,
  ];
}

export const WORKER_CONTRACT_HEADING = "Harness worker contract (authoritative):";

/** The worker-prompt section rendered from the shared definition. */
export function renderWorkerContractForWorker(kind: WorkerContractKind): string {
  return [WORKER_CONTRACT_HEADING, ...workerContractLines(kind)].join("\n");
}

/**
 * The reviewer-request section rendered from the same definition. It states
 * that contract-required behavior is authoritative and never a finding by
 * itself, without making any worker claim into evidence.
 */
export function renderWorkerContractForReviewer(kind: WorkerContractKind): string {
  return [
    WORKER_CONTRACT_HEADING,
    "The harness gave the worker the following contract alongside the task text above. Behavior this contract requires is authoritative and is never a finding by itself, including its required report sections and read-only verification.",
    ...workerContractLines(kind),
    "This contract does not make worker claims evidence. Judge the required outcome from the supplied evidence; when that evidence is insufficient, incomplete, or truncated, say so and block as the review policy allows.",
  ].join("\n");
}
