/**
 * The one opaque native CLI conversation identity rule (issue #277 restart
 * restoration identity slice).
 *
 * A native CLI conversation id is the provider-issued identifier of one Claude
 * Code or Codex conversation. Both pinned provider CLIs issue it as a UUID, so
 * the only accepted value is the fixed RFC 9562 textual UUID form: 8-4-4-4-12
 * hexadecimal digits separated by hyphens. Nothing else is ever an identity:
 * not a human session name, not a `latest`/`last`/`continue` alias, not a
 * path, not a prefix, and not a braced, URN, or whitespace-padded spelling.
 * No version or variant policy is applied: the provider owns what it issues,
 * and this rule only refuses values that cannot be one exact id.
 *
 * This identity is deliberately separate from every Pi identity field. It is
 * never a Pi `sessionId`, never part of a native Pi conversation tuple, and
 * never a status value. This module is pure: it validates only.
 */

const NATIVE_CONVERSATION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** True only for one exact provider-issued native conversation UUID. */
export function isNativeConversationId(value: unknown): value is string {
  return typeof value === "string" && NATIVE_CONVERSATION_ID_PATTERN.test(value);
}
