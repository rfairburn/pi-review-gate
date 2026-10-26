import { redactSensitiveText } from "../redaction";
import type { BackgroundCommandRecord } from "./task-state";
import { capNotificationText } from "./subtask-notifications";

/** Render only the request's canonical durable record, never an inferred outcome. */
export function formatHumanSteerNotice(executionId: string, taskId: string, command: BackgroundCommandRecord) {
  if (command.action !== "steer" || command.actor !== "user" || command.status === "failed") return undefined;
  const instructions = capNotificationText(redactSensitiveText(command.text ?? ""), 1_000);
  return {
    customType: "pi-review-subtask-steer",
    display: true as const,
    content: [
      `Human /subtask-steer accepted for execution ${executionId}, task ${taskId} (${command.instructionId}).`,
      `Request status: ${command.status}. Acceptance is not proof that the worker has applied the instructions or completed the task.`,
      `Submitted instruction: ${instructions}`,
      "Acknowledge briefly.",
    ].join("\n"),
    details: {
      origin: "human-command", executionId, taskId, instructionId: command.instructionId,
      status: command.status, interrupt: command.interrupt === true, instructions,
    },
  };
}
