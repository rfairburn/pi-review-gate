/**
 * #682: hook-side reader for the native Claude inbox announcement.
 *
 * Evidence (real Claude Code 2.1.330 probe): the root `SessionStart` command
 * hook inherits the inbox socket path and hook token in its ENVIRONMENT
 * (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`), not in its
 * stdin payload. This helper selects exactly those two names, and only for an
 * already-selected Claude root `SessionStart` (absent `agent_id`, per the
 * protocol's scope rule) on a platform where some endpoint proof exists
 * (`CLAUDE_INBOX_PROVABLE_PLATFORMS`: Linux, and macOS through the Darwin
 * proof), using the sender's own pure socket-path and token checks.
 *
 * It returns candidate input for the owner-only channel that will carry it to
 * the host; the host still captures the endpoint identity and proves the CLI
 * version before any send capability exists. It performs no I/O, connect, or
 * version probe, has no fallback, logs nothing, and never throws. A refusal is
 * `undefined`. A candidate is an opaque branded handle (the sender
 * capability's WeakMap pattern): the values live outside the object, so no
 * JSON, inspection mode, or property walk can reveal them, and only
 * {@link readClaudeInboxAnnouncement} hands them to the owner-only channel.
 */
import {
  CLAUDE_INBOX_PROVABLE_PLATFORMS,
  isValidClaudeInboxHookToken,
  isValidClaudeInboxSocketPath,
} from "./native-claude-inbox-delivery";
import { isNativeConversationId } from "./native-conversation";
import type { NativeHookEventMetadata } from "./native-hook-protocol";
import type { NativeCliBackend } from "./session-backend";

export const CLAUDE_INBOX_SOCKET_ENV = "CLAUDE_CODE_MESSAGING_SOCKET";
export const CLAUDE_INBOX_TOKEN_ENV = "CLAUDE_CODE_MESSAGING_TOKEN";

/** Announced inbox for one root session. `hookToken` is secret. */
export interface ClaudeInboxAnnouncement {
  readonly sessionId: string;
  readonly socketPath: string;
  readonly hookToken: string;
}

declare const candidateBrand: unique symbol;
/** Opaque branded handle. Holds no own properties and no serializable secret. */
export type ClaudeInboxAnnouncementCandidate = { readonly [candidateBrand]: true };

const REDACTED = "[ClaudeInboxAnnouncementCandidate]";
const candidateState = new WeakMap<object, ClaudeInboxAnnouncement>();
const candidatePrototype = Object.freeze({
  toJSON: (): string => REDACTED,
  toString: (): string => REDACTED,
  [Symbol.for("nodejs.util.inspect.custom")]: (): string => REDACTED,
});

/** Owner-only accessor: the announced values for a genuine candidate, else `undefined`. */
export function readClaudeInboxAnnouncement(candidate: ClaudeInboxAnnouncementCandidate): ClaudeInboxAnnouncement | undefined {
  return typeof candidate === "object" && candidate !== null ? candidateState.get(candidate) : undefined;
}

/**
 * Select the announced inbox from the hook environment, or `undefined`.
 * `metadata` must be the relay's selected metadata for the authenticated
 * `backend`; `platform` is an injectable seam defaulting to the host's.
 */
export function selectClaudeInboxAnnouncement(
  backend: NativeCliBackend,
  metadata: NativeHookEventMetadata,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ClaudeInboxAnnouncementCandidate | undefined {
  try {
    if (backend !== "claude" || !CLAUDE_INBOX_PROVABLE_PLATFORMS.includes(platform)) return undefined;
    if (metadata.hook_event_name !== "SessionStart" || metadata.agent_id !== undefined) return undefined;
    const sessionId = metadata.session_id;
    if (!isNativeConversationId(sessionId)) return undefined;
    const socketPath = env[CLAUDE_INBOX_SOCKET_ENV];
    const hookToken = env[CLAUDE_INBOX_TOKEN_ENV];
    if (!isValidClaudeInboxSocketPath(socketPath) || !isValidClaudeInboxHookToken(hookToken)) return undefined;
    const candidate = Object.freeze(Object.create(candidatePrototype) as object);
    candidateState.set(candidate, Object.freeze({ sessionId, socketPath, hookToken }));
    return candidate as ClaudeInboxAnnouncementCandidate;
  } catch {
    return undefined;
  }
}
