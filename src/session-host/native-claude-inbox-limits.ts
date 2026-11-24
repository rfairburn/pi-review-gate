/**
 * #682: shared native Claude inbox socket-path bound.
 *
 * It lives in its own dependency-free module so both the shared sender
 * (./native-claude-inbox-delivery) and the Darwin endpoint proof it uses
 * (./native-claude-darwin-inbox-endpoint) read one value without an import
 * cycle. The sender re-exports it unchanged.
 */

/** Portable Unix socket path bound (macOS sun_path is 104 bytes incl. NUL). */
export const CLAUDE_INBOX_MAX_SOCKET_PATH_BYTES = 103;
