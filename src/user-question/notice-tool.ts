/**
 * YouShouldKnow tool (issue #295).
 *
 * Registers a non-interactive notice in the same session-local pending list
 * as AskUserQuestion. The full Markdown body and optional context remain in
 * the controller until the user explicitly closes the notice or requests More
 * details; that action closes the popup, consumes the notice, then makes an
 * ordinary, checked request for a normal conversation elaboration.
 */

import type { UserQuestionController } from "./controller";
import { visibleTerminalText } from "../tool-result-text";

export const YOU_SHOULD_KNOW_TOOL_NAME = "YouShouldKnow";

export interface YouShouldKnowTool {
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
    context?: { sessionManager?: unknown },
  ): Promise<Record<string, unknown>>;
}

export function createYouShouldKnowTool(controller: UserQuestionController): YouShouldKnowTool {
  return {
    name: YOU_SHOULD_KNOW_TOOL_NAME,
    label: "You should know",
    description:
      "Show the user a notice with a compact title and its full Markdown body. "
      + "The notice stays pending until the user closes it or requests More details; that action closes the popup and consumes the notice before delivery, and a delivery failure does not restore it.",
    promptSnippet:
      "YouShouldKnow — show a user notice using a compact title, full Markdown body, and optional context; More details consumes the notice before asking for ordinary conversation elaboration, while Close dismisses it without sending.",
    promptGuidelines: [
      "Use YouShouldKnow to present information the user should see without asking them to decide or answer.",
      "Keep title compact, and put the complete substantial content in body as Markdown; use context only for relevant additional context.",
      "The notice remains pending until the user chooses Close or requests More details. More details closes the popup, consumes the notice, and delivers its full body and context with an explicit request for elaboration in a normal conversation reply.",
    ],
    executionMode: "sequential",
    parameters: youShouldKnowSchema(),
    async execute(id, params, _signal, _onUpdate, context) {
      const registered = controller.registerNotice(
        {
          toolCallId: id,
          title: typeof params.title === "string" ? params.title : "",
          body: typeof params.body === "string" ? params.body : "",
          ...(Object.prototype.hasOwnProperty.call(params, "context")
            ? { context: params.context as string }
            : {}),
        },
        context?.sessionManager,
      );
      if (!registered.ok) {
        return {
          content: [{ type: "text", text: registered.message }],
          details: { status: "rejected", reason: registered.reason },
        };
      }
      return {
        content: [{
          type: "text",
          text:
            `Notice registered as ${registered.notice.id}: "${visibleTerminalText(registered.notice.title)}". `
            + "It stays pending until the user closes it or requests More details from the pending-item list.",
        }],
        details: { status: "pending", id: registered.notice.id, kind: "notice" },
      };
    },
  };
}

function youShouldKnowSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      title: {
        type: "string",
        minLength: 1,
        description: "A compact identifier for the notice, shown in the pending list and popup title.",
      },
      body: {
        type: "string",
        minLength: 1,
        description: "The complete substantive notice content as Markdown. It is retained and rendered in full, without truncation.",
      },
      context: {
        type: "string",
        description: "Optional complete relevant context, retained and delivered with the body if the user chooses More details.",
      },
    },
    required: ["title", "body"],
  };
}
