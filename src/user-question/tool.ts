/**
 * AskUserQuestion tool (issue #95).
 *
 * Lets a model ask the user a question with optional choices, in two modes:
 *
 * - `async` (default): registers the question and returns a pending handle
 *   immediately. The question stays discoverable through the tool result and
 *   the pending-question list; there is no deadline, reminder, or fabricated
 *   answer. The user's answer arrives later as an ordinary user message
 *   (steering while busy, normal delivery when idle).
 * - `sync`: waits for the user's answer or explicit decline. A decline
 *   resolves with a terminating result: in a question-only batch that ends
 *   the run; in a mixed batch the remaining results are still delivered and
 *   the model may continue with them (host loop semantics). The run is never
 *   aborted to deliver an answer, and there is no Escape-abort fallback —
 *   decline is the only way out of a sync wait.
 *
 * Registration is session-bound: the controller rechecks the calling
 * context's session identity at registration, presentation, and submission,
 * so questions never cross session switches, /new, or forks.
 */

import type { SyncWaitResult, UserQuestionController } from "./controller";

export const USER_QUESTION_TOOL_NAME = "AskUserQuestion";

/** The host tool-registration surface; mirrors the shape used by WebToolManager. */
export interface UserQuestionToolHost {
  registerTool(tool: UserQuestionTool): unknown;
}

export interface UserQuestionTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode: "sequential";
  parameters: Record<string, unknown>;
  execute(
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: UserQuestionToolContext,
  ): Promise<Record<string, unknown>>;
}

export interface UserQuestionToolContext {
  sessionManager?: unknown;
}

export interface UserQuestionToolOptions {
  /** Platform label of the pending-question shortcut, for tool results. */
  shortcutLabel: string;
}

export function createUserQuestionTool(
  controller: UserQuestionController,
  options: UserQuestionToolOptions,
): UserQuestionTool {
  return {
    name: USER_QUESTION_TOOL_NAME,
    label: "Ask user question",
    description:
      "Ask the user a question with optional suggested answers. Async by default: registers the question and returns immediately; " +
      "the answer arrives later as a user message. Use mode 'sync' only when you cannot proceed at all without the answer; " +
      "it waits for the answer or an explicit decline.",
    promptSnippet:
      "AskUserQuestion — ask the user a question (optional choices); async by default, 'sync' waits for the answer or decline.",
    promptGuidelines: [
      "Use AskUserQuestion when a decision is needed that only the user can make; it is asynchronous by default — register the question and continue other work.",
      "Never assume an answer to a pending question; the user's answer arrives as a later user message, or the user may decline (in which case do not proceed with the gated work).",
      "Use AskUserQuestion with mode 'sync' only when you cannot proceed at all without the answer; it blocks until the user answers or explicitly declines.",
    ],
    executionMode: "sequential",
    parameters: userQuestionToolSchema(),
    async execute(id, params, signal, _onUpdate, context) {
      const registered = controller.register(
        {
          toolCallId: id,
          question: typeof params.question === "string" ? params.question : "",
          choices: Array.isArray(params.choices) ? params.choices.map(String) : undefined,
          mode: params.mode === "sync" ? "sync" : "async",
        },
        context?.sessionManager,
      );
      if (!registered.ok) {
        return {
          content: [{ type: "text", text: registered.message }],
          details: { status: "rejected", reason: registered.reason },
        };
      }
      const question = registered.question;
      if (question.mode === "async") {
        return {
          content: [{ type: "text", text: formatAsyncPending(question, options.shortcutLabel) }],
          details: { status: "pending", id: question.id, mode: "async" },
        };
      }
      const wait = await controller.waitForAnswer(question.id, signal);
      return mapSyncResult(question, wait);
    },
  };
}

function userQuestionToolSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      question: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description:
          "The question to ask the user. One focused question; it is shown verbatim in the pending-question list.",
      },
      choices: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 300 },
        maxItems: 12,
        description:
          "Optional suggested answers. The user may always type a free-text answer instead, or decline.",
      },
      mode: {
        type: "string",
        enum: ["async", "sync"],
        default: "async",
        description:
          "'async' (default): registers the question and returns immediately; the answer arrives later as a user message. " +
          "'sync': waits for the user's answer or explicit decline before returning.",
      },
    },
    required: ["question"],
  };
}

function formatAsyncPending(question: { id: string; question: string }, shortcutLabel: string): string {
  return (
    `Question registered as ${question.id}: "${question.question}"\n` +
    `It stays pending until the user answers or declines it from the pending-question list (${shortcutLabel}). ` +
    "Continue with other work; do not assume an answer — it will arrive later as a user message, or the user may decline."
  );
}

function mapSyncResult(
  question: { id: string; question: string },
  result: SyncWaitResult,
): Record<string, unknown> {
  if (result.outcome === "answered" && result.answer !== undefined) {
    return {
      content: [{ type: "text", text: `The user answered "${question.question}": ${result.answer}` }],
      details: { status: "answered", id: question.id, answer: result.answer, wasChoice: result.wasChoice ?? false },
    };
  }
  if (result.outcome === "declined") {
    return {
      content: [
        {
          type: "text",
          text:
            `The user declined to answer "${question.question}". Do not proceed with the work this question gated. ` +
            "If no other work remains, stop.",
        },
      ],
      details: { status: "declined", id: question.id },
      // Terminating for question-only batches; a mixed batch continues when
      // its other results are not terminating (host loop semantics).
      terminate: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: "Question resolution was interrupted (the run was aborted or the session ended). No answer was recorded.",
      },
    ],
    details: { status: "interrupted", id: question.id, outcome: result.outcome },
  };
}
