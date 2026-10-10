import {
  MAX_SESSION_SPAWN_PROMPT_BYTES,
  MAX_SESSION_SPAWN_TITLE_BYTES,
  MAX_SESSION_SPAWN_WORKSPACE_BYTES,
  isValidRenameName,
  type SessionSpawnInput,
  type SessionSpawnOutcome,
} from "./protocol";
import type { SessionHostSpawnCapability } from "./spawn-capability";

export const SESSION_SPAWN_TOOL_NAME = "SessionSpawn";

export interface SessionSpawnToolHost {
  registerTool(tool: Record<string, unknown>): unknown;
}

/** Parse exactly the model-facing contract without trimming or rewriting any supplied value. */
export function parseSessionSpawnInput(value: unknown): SessionSpawnInput {
  if (!isRecord(value)) throw new Error("SessionSpawn requires workspace, title, and prompt string arguments.");
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("workspace") || !keys.includes("title") || !keys.includes("prompt")) {
    throw new Error("SessionSpawn accepts exactly workspace, title, and prompt.");
  }
  const { workspace, title, prompt } = value;
  if (typeof workspace !== "string" || workspace.length === 0
    || Buffer.byteLength(workspace, "utf8") > MAX_SESSION_SPAWN_WORKSPACE_BYTES
    || workspace.includes("\0")) {
    throw new Error("SessionSpawn workspace must be a nonempty path within the transport safety bound.");
  }
  if (!isValidRenameName(title) || Buffer.byteLength(title, "utf8") > MAX_SESSION_SPAWN_TITLE_BYTES) {
    throw new Error("SessionSpawn title must be nonempty and within the transport safety bound.");
  }
  if (typeof prompt !== "string" || prompt.length === 0
    || Buffer.byteLength(prompt, "utf8") > MAX_SESSION_SPAWN_PROMPT_BYTES
    || prompt.includes("\0")) {
    throw new Error("SessionSpawn prompt must be nonempty and within the transport safety bound.");
  }
  return { workspace, title, prompt };
}

export function sessionSpawnToolSchema(titleColumns: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["workspace", "title", "prompt"],
    properties: {
      workspace: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SESSION_SPAWN_WORKSPACE_BYTES,
        description: "Existing workspace directory for the new independent sidebar child. The host never creates a worktree, clone, or branch.",
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SESSION_SPAWN_TITLE_BYTES,
        description: `Friendly native Pi session title. At child launch, the host's visible-layout sidebar title-space snapshot is ${titleColumns} terminal columns. Keeping the title to about ${titleColumns} columns is an optimal/soft target, not a maximum or truncation guarantee; longer titles are accepted within the independent transport safety bound. The title is forwarded unchanged to Pi's native session-name API, whose persistence semantics may normalize surrounding whitespace (Pi 1.1.0 trims it). No host-side width-based clipping or shortening is applied. The snapshot may differ after terminal resize.`,
      },
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SESSION_SPAWN_PROMPT_BYTES,
        description: "Exact initial user prompt sent to the new child. Flag-looking text is data, not a Pi startup option.",
      },
    },
  };
}

/** Register only when the top-level hosted child has reporter-published authority. */
export function registerSessionSpawnTool(
  pi: unknown,
  capability: SessionHostSpawnCapability | undefined,
): boolean {
  if (!capability || !Number.isSafeInteger(capability.titleColumns) || capability.titleColumns < 1
    || capability.titleColumns > 1000 || !isRecord(pi) || typeof pi.registerTool !== "function") return false;
  const host = pi as unknown as SessionSpawnToolHost;
  host.registerTool({
    name: SESSION_SPAWN_TOOL_NAME,
    label: SESSION_SPAWN_TOOL_NAME,
    description:
      "Create a fresh independent native Pi child in the session-host sidebar using an existing workspace, a friendly title, and an exact initial prompt. " +
      "The host does not create worktrees, clones, or branches, and the new child starts in the background without changing selection, focus, or sidebar visibility. " +
      `The visible-layout sidebar title-space snapshot at child launch is ${capability.titleColumns} terminal columns; this is an optimal/soft target, not a title limit or truncation guarantee, and can change after terminal resize. ` +
      "A successful result confirms child launch only, not that its prompt has completed.",
    promptSnippet:
      "Use SessionSpawn only to add a fresh independent session-host sidebar child. Supply an existing workspace, friendly title, and exact initial prompt; no worktree, clone, branch, focus change, or prompt-completion claim is involved.",
    promptGuidelines: [
      "The requested workspace must already exist. SessionSpawn never creates worktrees, clones, or branches.",
      "Pass the title and prompt as requested. A title-length recommendation is soft guidance only; long titles are accepted within the transport safety bound, and the host does not clip or shorten them to fit. Pi's native title persistence may normalize surrounding whitespace.",
      "A successful result means the child process launched, not that its prompt was processed or completed. If the outcome is unknown, inspect the sidebar before retrying; SessionSpawn does not retry automatically.",
    ],
    executionMode: "sequential",
    parameters: sessionSpawnToolSchema(capability.titleColumns),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const input = parseSessionSpawnInput(params);
      const outcome = await capability.spawn(input, signal);
      return sessionSpawnResult(outcome);
    },
  });
  return true;
}

export function sessionSpawnResult(outcome: SessionSpawnOutcome): Record<string, unknown> {
  const text = outcome === "started"
    ? "A new sidebar child launched successfully and is running in the background. This confirms launch only; its initial prompt may still be processing."
    : outcome === "failed"
      ? "The host did not confirm a successful child launch. Check the session-host sidebar before retrying."
      : "The spawn outcome is unknown because the request timed out, was cancelled, or its authenticated connection ended after sending. The child may or may not exist; check the sidebar before retrying. No automatic retry was made.";
  return {
    content: [{ type: "text", text }],
    details: { outcome },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
