/**
 * Canonical delegation tool names (issue #653).
 *
 * The one dependency-free source of the `Subtasks*` registration names: the
 * real registrar in `./tool.ts` registers exactly these names (one tool per
 * action, in this action order), and configuration-only consumers such as the
 * standalone review-settings catalog read the same map without importing the
 * executor implementation graph. A name here is a configuration candidate
 * only; it never grants, activates, or proves availability of a tool.
 */

/** Every delegation action, in registration order. */
export const EXECUTION_TOOL_ACTIONS = ["start", "add", "inspect", "watch", "continue", "steer", "interrupt", "force_merge", "mark_clean"] as const;

export type ExecutionToolAction = typeof EXECUTION_TOOL_ACTIONS[number];

export const EXECUTION_TOOL_NAMES: Record<ExecutionToolAction, string> = {
  start: "SubtasksStart",
  add: "SubtasksAdd",
  inspect: "SubtasksInspect",
  watch: "SubtasksWatch",
  continue: "SubtasksContinue",
  steer: "SubtasksSteer",
  interrupt: "SubtasksInterrupt",
  force_merge: "SubtasksForceMerge",
  mark_clean: "SubtasksMarkClean",
};
