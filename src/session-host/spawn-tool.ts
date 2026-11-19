import {
  MAX_SESSION_SPAWN_TITLE_BYTES,
  MAX_SESSION_SPAWN_WORKSPACE_BYTES,
  hasSessionSpawnRouting,
  isValidRenameName,
  isValidSessionSpawnHost,
  type SessionSpawnInput,
  type SessionSpawnOutcome,
} from "./protocol";
import { MAX_PEER_DESTINATION_ID_CHARS } from "./peer-destination-id";
import { SESSION_BACKENDS, isSessionBackend } from "./session-backend";
import { hasSessionHostsInspection, type SessionHostSpawnCapability } from "./spawn-capability";
import { isRecord } from "../record-guard";

export const SESSION_SPAWN_TOOL_NAME = "SessionSpawn";

export interface SessionSpawnToolHost {
  registerTool(tool: Record<string, unknown>): unknown;
}

const REQUIRED_SPAWN_KEYS: readonly string[] = ["workspace", "title", "prompt"];
const OPTIONAL_SPAWN_KEYS: readonly string[] = ["host", "kind", "createWorkspace"];

/**
 * Parse exactly the model-facing contract without trimming or rewriting any
 * supplied value. The three required fields keep their legacy meaning; the
 * optional `host`/`kind` selectors are returned only when present, exactly as
 * supplied. Whether this session can honor them is decided by the capability,
 * never by silently dropping them here.
 */
export function parseSessionSpawnInput(value: unknown): SessionSpawnInput {
  if (!isRecord(value)) throw new Error("SessionSpawn requires workspace, title, and prompt string arguments.");
  const keys = Object.keys(value);
  if (!REQUIRED_SPAWN_KEYS.every((key) => keys.includes(key))
    || keys.some((key) => !REQUIRED_SPAWN_KEYS.includes(key) && !OPTIONAL_SPAWN_KEYS.includes(key))) {
    throw new Error("SessionSpawn accepts exactly workspace, title, and prompt, plus optional host, kind, and createWorkspace.");
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
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.includes("\0")) {
    throw new Error("SessionSpawn prompt must be a nonempty string without NUL characters.");
  }
  const hasHost = keys.includes("host");
  const hasKind = keys.includes("kind");
  if (hasHost && !isValidSessionSpawnHost(value.host)) {
    throw new Error(`SessionSpawn host must be an exact paired host id: a nonempty string of at most ${MAX_PEER_DESTINATION_ID_CHARS} UTF-16 code units without control or line-separator characters.`);
  }
  if (hasKind && !isSessionBackend(value.kind)) {
    throw new Error(`SessionSpawn kind must be one of ${SESSION_BACKENDS.join(", ")}.`);
  }
  if (keys.includes("createWorkspace") && typeof value.createWorkspace !== "boolean") {
    throw new Error("SessionSpawn createWorkspace must be a boolean.");
  }
  return {
    workspace,
    title,
    prompt,
    ...(hasHost ? { host: value.host as string } : {}),
    ...(hasKind ? { kind: value.kind as NonNullable<SessionSpawnInput["kind"]> } : {}),
    // Only `true` asks for anything; `false` is exactly the noncreating request.
    ...(value.createWorkspace === true ? { createWorkspace: true } : {}),
  };
}

/** Options for the model-facing schema; routing selectors are advertised only with routed-spawn support. */
export interface SessionSpawnToolSchemaOptions {
  readonly routing?: boolean;
  /** True only with an actual SessionHosts inspection capability; adds static discovery guidance. */
  readonly discovery?: boolean;
  /**
   * True only with an actual declared routed workspace-creation capability; adds
   * the optional `createWorkspace` property. Absent: the schema is unchanged.
   */
  readonly createWorkspace?: boolean;
}

/** Truthful wording for the optional destination workspace creation. */
export const SESSION_SPAWN_CREATE_WORKSPACE_GUIDANCE =
  "Set createWorkspace to true only when the workspace directory may not exist yet: the destination host then creates it, and any missing parent directories, like a recursive mkdir before launching the child normally; an existing directory is reused unchanged. It never creates worktrees, clones, or branches, never changes permissions, and directories it created are not removed if the launch then fails. Omit it (or pass false) to require an existing workspace.";

/**
 * Truthful routed prompt-delivery wording: a Pi child is unchanged, while a
 * native provider child may receive the lossless original through a host-owned
 * file plus a short startup instruction to read it.
 */
export const SESSION_SPAWN_ROUTED_PROMPT_DELIVERY =
  "A Pi child receives it as its initial user prompt. A claude or codex child may instead have the original prompt stored losslessly in a host-owned file, with a short startup instruction asking the provider to read it, so the provider's first message is not necessarily the verbatim prompt.";

/** Static SessionHosts pointer used only when the actual inspection capability exists. */
export const SESSION_SPAWN_DISCOVERY_GUIDANCE =
  "Omit host for this session's own host; omit kind for Pi. Use SessionHosts for paired host ids, their saved friendly labels, and current kind observations; pass the listed id, not the label, as host.";

export function sessionSpawnToolSchema(
  titleColumns: number,
  options: SessionSpawnToolSchemaOptions = {},
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["workspace", "title", "prompt"],
    properties: {
      workspace: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SESSION_SPAWN_WORKSPACE_BYTES,
        description: options.createWorkspace === true
          ? "Workspace directory for the new independent sidebar child. It must already exist unless createWorkspace is true. The host never creates a worktree, clone, or branch."
          : "Existing workspace directory for the new independent sidebar child. The host never creates a worktree, clone, or branch.",
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: MAX_SESSION_SPAWN_TITLE_BYTES,
        description: options.routing === true
          // Routed children may be any kind: describe each kind's own normal
          // title handling without claiming every child uses Pi's API.
          ? `Friendly title for the new child. At child launch, the host's visible-layout sidebar title-space snapshot is ${titleColumns} terminal columns. Keeping the title to about ${titleColumns} columns is an optimal/soft target, not a maximum or truncation guarantee; longer titles are accepted within the independent transport safety bound. The title is passed unchanged to the child kind's normal session-title handling, whose own persistence semantics may normalize it (for example, Pi trims surrounding whitespace). No host-side width-based clipping or shortening is applied. The snapshot may differ after terminal resize.`
          : `Friendly native Pi session title. At child launch, the host's visible-layout sidebar title-space snapshot is ${titleColumns} terminal columns. Keeping the title to about ${titleColumns} columns is an optimal/soft target, not a maximum or truncation guarantee; longer titles are accepted within the independent transport safety bound. The title is forwarded unchanged to Pi's native session-name API, whose persistence semantics may normalize surrounding whitespace (Pi 1.1.0 trims it). No host-side width-based clipping or shortening is applied. The snapshot may differ after terminal resize.`,
      },
      prompt: {
        type: "string",
        minLength: 1,
        description: options.routing === true
          ? `Exact initial request for the new child. There is no fixed prompt-length limit; the exact text is staged through the host's private payload transport. ${SESSION_SPAWN_ROUTED_PROMPT_DELIVERY} Flag-looking text is data, not a startup option.`
          : "Exact initial user prompt sent to the new child. There is no fixed prompt-length limit; the exact text is staged through the host's private payload transport. Flag-looking text is data, not a Pi startup option.",
      },
      ...(options.routing === true ? {
        host: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PEER_DESTINATION_ID_CHARS,
          description: "Optional exact paired host id for the new child, matched exactly as supplied (no trimming or case folding). Omit it to start the child on this session's own host; omission never means the host currently selected or viewed in the sidebar. If the selected host cannot accept the request, the spawn is refused; it never falls back to this host."
            + (options.discovery === true ? ` ${SESSION_SPAWN_DISCOVERY_GUIDANCE}` : ""),
        },
        kind: {
          type: "string",
          enum: [...SESSION_BACKENDS],
          description: "Optional backend for the new child: pi, claude, or codex. Omit it for pi. If the requested backend cannot be started on the selected host, the spawn is refused; it never falls back to a Pi child.",
        },
        ...(options.createWorkspace === true ? {
          createWorkspace: {
            type: "boolean",
            description: `Optional. ${SESSION_SPAWN_CREATE_WORKSPACE_GUIDANCE} If the selected host cannot honor it, the spawn is refused rather than started without it.`,
          },
        } : {}),
      } : {}),
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
  const routing = capability.routing === true;
  // Discovery guidance is static text and appears only with the actual
  // reporter-published inspection capability, never as a dynamic roster.
  const discovery = routing && hasSessionHostsInspection(capability);
  // Workspace creation is advertised only with the declared routed capability.
  const createWorkspace = routing && capability.createWorkspace === true;
  host.registerTool({
    name: SESSION_SPAWN_TOOL_NAME,
    label: SESSION_SPAWN_TOOL_NAME,
    description:
      (createWorkspace
        ? "Create a fresh independent sidebar child (a Pi child on this session's own host unless the optional host or kind selects another host or session kind) using an existing workspace (or one the destination host creates when createWorkspace is true), a friendly title, and an exact initial request. "
        : routing
        ? "Create a fresh independent sidebar child (a Pi child on this session's own host unless the optional host or kind selects another host or session kind) using an existing workspace, a friendly title, and an exact initial request. "
        : "Create a fresh independent native Pi child in the session-host sidebar using an existing workspace, a friendly title, and an exact initial prompt. ") +
      "The host does not create worktrees, clones, or branches, and the new child starts in the background without changing selection, focus, or sidebar visibility. " +
      `The visible-layout sidebar title-space snapshot at child launch is ${capability.titleColumns} terminal columns; this is an optimal/soft target, not a title limit or truncation guarantee, and can change after terminal resize. ` +
      "A successful result confirms child launch only, not that its prompt has completed.",
    promptSnippet: createWorkspace
      ? "Use SessionSpawn only to add a fresh independent session-host sidebar child. Supply a workspace (existing, or created as a plain directory when createWorkspace is true), friendly title, and exact initial prompt; no worktree, clone, branch, focus change, or prompt-completion claim is involved."
      : "Use SessionSpawn only to add a fresh independent session-host sidebar child. Supply an existing workspace, friendly title, and exact initial prompt; no worktree, clone, branch, focus change, or prompt-completion claim is involved.",
    promptGuidelines: [
      createWorkspace
        ? "The requested workspace must already exist unless createWorkspace is true. SessionSpawn never creates worktrees, clones, or branches."
        : "The requested workspace must already exist. SessionSpawn never creates worktrees, clones, or branches.",
      routing
        ? "Pass the title and prompt as requested. A title-length recommendation is soft guidance only; long titles are accepted within the transport safety bound, and the host does not clip or shorten them to fit. Each child kind's normal title persistence may normalize surrounding whitespace."
        : "Pass the title and prompt as requested. A title-length recommendation is soft guidance only; long titles are accepted within the transport safety bound, and the host does not clip or shorten them to fit. Pi's native title persistence may normalize surrounding whitespace.",
      "A successful result means the child process launched, not that its prompt was processed or completed. If the outcome is unknown, inspect the sidebar before retrying; SessionSpawn does not retry automatically.",
      ...(routing ? [
        "host and kind are optional. Omitting host starts the child on this session's own host, never the host selected or viewed in the sidebar; omitting kind starts a Pi child. A host or kind the request cannot honor is refused rather than replaced by a local Pi child.",
        `SessionSpawn prompt delivery: ${SESSION_SPAWN_ROUTED_PROMPT_DELIVERY} Either way, success confirms launch only, not that the prompt was read or completed.`,
      ] : []),
      ...(discovery ? [`SessionSpawn: ${SESSION_SPAWN_DISCOVERY_GUIDANCE}`] : []),
      ...(createWorkspace ? [`SessionSpawn createWorkspace: ${SESSION_SPAWN_CREATE_WORKSPACE_GUIDANCE}`] : []),
    ],
    executionMode: "sequential",
    parameters: sessionSpawnToolSchema(capability.titleColumns, {
      routing,
      discovery,
      ...(createWorkspace ? { createWorkspace: true } : {}),
    }),
    execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
      const input = parseSessionSpawnInput(params);
      if (!routing && hasSessionSpawnRouting(input)) {
        // Never drop explicit selectors and launch a local Pi child instead.
        throw new Error("SessionSpawn host/kind routing is not available in this session, so nothing was started. Omit host and kind to start a Pi child on this session's own host.");
      }
      if (!createWorkspace && input.createWorkspace === true) {
        // Never drop a creation request and launch against a missing workspace.
        throw new Error("SessionSpawn createWorkspace is not available in this session, so nothing was started. Create the workspace first, or omit createWorkspace to use an existing workspace.");
      }
      const outcome = await capability.spawn(input, signal);
      return sessionSpawnResult(outcome);
    },
  });
  return true;
}

export function sessionSpawnResult(outcome: SessionSpawnOutcome): Record<string, unknown> {
  const text = outcome === "started"
    ? "A new sidebar child process launched in the background. This confirms launch only; its initial request may not yet have been processed."
    : outcome === "failed"
      ? "The host did not confirm a successful child launch. Check the session-host sidebar before retrying."
      : "The host could not confirm the child launch outcome. A child may exist or may already have exited; check the sidebar before retrying. No automatic retry was made.";
  return {
    content: [{ type: "text", text }],
    details: { outcome },
  };
}
