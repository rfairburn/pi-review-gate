/**
 * #682: hook-side selection of the native Claude inbox announcement.
 *
 * Pure: no socket, filesystem, Claude CLI, or provider account. Inputs mirror
 * the real Claude Code 2.1.330 probe, where the root SessionStart command hook
 * inherited CLAUDE_CODE_MESSAGING_SOCKET and CLAUDE_CODE_MESSAGING_TOKEN in its
 * environment (not stdin). Metadata is produced by the relay's own selector.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  CLAUDE_INBOX_SOCKET_ENV,
  CLAUDE_INBOX_TOKEN_ENV,
  readClaudeInboxAnnouncement,
  selectClaudeInboxAnnouncement,
  type ClaudeInboxAnnouncementCandidate,
} from "../src/session-host/native-claude-inbox-announcement";
import {
  CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES,
  CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES,
} from "../src/session-host/native-claude-inbox-delivery";
import {
  sanitizeNativeHookProviderInput,
  type NativeHookEventMetadata,
} from "../src/session-host/native-hook-protocol";

const SESSION_ID = "0f6b3c9e-1d2a-4b5c-8d7e-9f0a1b2c3d4e";
const SOCKET = "/tmp/claude-1000/messaging-4b5c.sock";
const TOKEN = "secret-hook-token-7f3a91";
const ENV = Object.freeze({ [CLAUDE_INBOX_SOCKET_ENV]: SOCKET, [CLAUDE_INBOX_TOKEN_ENV]: TOKEN });

function selected(payload: Record<string, unknown>): NativeHookEventMetadata {
  const result = sanitizeNativeHookProviderInput(payload);
  assert.equal(result.ok, true);
  return (result as { ok: true; metadata: NativeHookEventMetadata }).metadata;
}

const ROOT_START = selected({
  hook_event_name: "SessionStart",
  session_id: SESSION_ID,
  transcript_path: `/home/u/.claude/projects/p/${SESSION_ID}.jsonl`,
  cwd: "/home/u/work",
  source: "startup",
});

test("selects the exact env names for a validated Claude root SessionStart on Linux", () => {
  assert.equal(CLAUDE_INBOX_SOCKET_ENV, "CLAUDE_CODE_MESSAGING_SOCKET");
  assert.equal(CLAUDE_INBOX_TOKEN_ENV, "CLAUDE_CODE_MESSAGING_TOKEN");
  const candidate = selectClaudeInboxAnnouncement("claude", ROOT_START, { ...ENV, UNRELATED: "x" }, "linux");
  assert.ok(candidate);
  assert.ok(Object.isFrozen(candidate));
  assert.deepEqual(Reflect.ownKeys(candidate), []);
  const values = readClaudeInboxAnnouncement(candidate);
  assert.deepEqual(values, { sessionId: SESSION_ID, socketPath: SOCKET, hookToken: TOKEN });
  assert.ok(Object.isFrozen(values));
});

test("the accessor refuses look-alike handles", () => {
  const lookAlike = { sessionId: SESSION_ID, socketPath: SOCKET, hookToken: TOKEN } as unknown as ClaudeInboxAnnouncementCandidate;
  assert.equal(readClaudeInboxAnnouncement(lookAlike), undefined);
  assert.equal(readClaudeInboxAnnouncement(null as unknown as ClaudeInboxAnnouncementCandidate), undefined);
  assert.equal(readClaudeInboxAnnouncement("x" as unknown as ClaudeInboxAnnouncementCandidate), undefined);
});

test("a candidate does not expose the token through ordinary output", () => {
  const candidate = selectClaudeInboxAnnouncement("claude", ROOT_START, ENV, "linux");
  assert.ok(candidate);
  for (const rendered of [
    JSON.stringify(candidate),
    JSON.stringify({ candidate }),
    inspect(candidate, { showHidden: true, depth: 5 }),
    inspect(candidate, { showHidden: true, customInspect: false, depth: 5 }),
    inspect({ candidate }, { showHidden: true, customInspect: false, depth: 5 }),
    inspect(Object.getOwnPropertyDescriptors(candidate), { showHidden: true, customInspect: false }),
    String(candidate),
    `${candidate}`,
    JSON.stringify({ ...candidate }),
    JSON.stringify(Object.keys(candidate)),
    JSON.stringify(Object.assign({}, candidate)),
  ]) {
    assert.ok(!rendered.includes(TOKEN), rendered);
    assert.ok(!rendered.includes(SOCKET), rendered);
  }
});

test("refuses other backends, platforms, events, and subagent scope", () => {
  assert.equal(selectClaudeInboxAnnouncement("codex", ROOT_START, ENV, "linux"), undefined);
  for (const platform of ["darwin", "win32", "freebsd"] as const) {
    assert.equal(selectClaudeInboxAnnouncement("claude", ROOT_START, ENV, platform), undefined, platform);
  }
  for (const hook_event_name of ["Stop", "SubagentStop", "UserPromptSubmit", "SessionEnd", "PreToolUse"]) {
    const metadata = selected({ hook_event_name, session_id: SESSION_ID });
    assert.equal(selectClaudeInboxAnnouncement("claude", metadata, ENV, "linux"), undefined, hook_event_name);
  }
  const subagent = selected({ hook_event_name: "SessionStart", session_id: SESSION_ID, agent_id: "a1b2c3" });
  assert.equal(selectClaudeInboxAnnouncement("claude", subagent, ENV, "linux"), undefined);
});

test("refuses absent or malformed session ids", () => {
  for (const session_id of [undefined, "latest", `${SESSION_ID}x`, `{${SESSION_ID}}`]) {
    const payload: Record<string, unknown> = { hook_event_name: "SessionStart" };
    if (session_id !== undefined) payload.session_id = session_id;
    assert.equal(selectClaudeInboxAnnouncement("claude", selected(payload), ENV, "linux"), undefined, String(session_id));
  }
});

test("refuses absent, malformed, or oversized socket paths and tokens", () => {
  const longSocket = `/${"s".repeat(CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES)}`;
  const longToken = "t".repeat(CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES + 1);
  const cases: Record<string, unknown>[] = [
    {},
    { [CLAUDE_INBOX_SOCKET_ENV]: SOCKET },
    { [CLAUDE_INBOX_TOKEN_ENV]: TOKEN },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: "" },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: "relative/inbox.sock" },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: "/" },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: "/tmp/dir/" },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: "/tmp/../tmp/inbox.sock" },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: "/tmp/in\0box.sock" },
    { ...ENV, [CLAUDE_INBOX_SOCKET_ENV]: longSocket },
    { ...ENV, [CLAUDE_INBOX_TOKEN_ENV]: "" },
    { ...ENV, [CLAUDE_INBOX_TOKEN_ENV]: longToken },
    { ...ENV, [CLAUDE_INBOX_TOKEN_ENV]: "tok\ud800en" },
    // Near-miss names are never selected.
    { claude_code_messaging_socket: SOCKET, claude_code_messaging_token: TOKEN },
    { CLAUDE_CODE_MESSAGING_SOCKET_PATH: SOCKET, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN },
  ];
  for (const env of cases) {
    assert.equal(selectClaudeInboxAnnouncement("claude", ROOT_START, env as NodeJS.ProcessEnv, "linux"), undefined);
  }
  // Exactly at the bounds is admitted.
  const edgeSocket = `/${"s".repeat(CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES - 1)}`;
  const edgeToken = "t".repeat(CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES);
  const edge = selectClaudeInboxAnnouncement("claude", ROOT_START, {
    [CLAUDE_INBOX_SOCKET_ENV]: edgeSocket,
    [CLAUDE_INBOX_TOKEN_ENV]: edgeToken,
  }, "linux");
  assert.ok(edge);
  assert.equal(readClaudeInboxAnnouncement(edge)?.socketPath, edgeSocket);
  assert.equal(readClaudeInboxAnnouncement(edge)?.hookToken.length, CLAUDE_INBOX_MAX_HOOK_TOKEN_BYTES);
});

test("stdin payload fields are never a source and never selected into metadata", () => {
  const metadata = selected({
    hook_event_name: "SessionStart",
    session_id: SESSION_ID,
    [CLAUDE_INBOX_SOCKET_ENV]: SOCKET,
    [CLAUDE_INBOX_TOKEN_ENV]: TOKEN,
  });
  assert.ok(!JSON.stringify(metadata).includes(TOKEN));
  assert.equal(selectClaudeInboxAnnouncement("claude", metadata, {}, "linux"), undefined);
});

test("never throws on hostile env access", () => {
  const env = new Proxy({}, { get: () => { throw new Error(TOKEN); } });
  assert.equal(selectClaudeInboxAnnouncement("claude", ROOT_START, env, "linux"), undefined);
});
