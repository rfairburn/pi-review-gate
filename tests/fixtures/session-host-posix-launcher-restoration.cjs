'use strict';

/**
 * POSIX source-launcher acceptance restoration witnesses.
 *
 * The bounded comparison logic is platform-neutral: it compares only the
 * caller's original stdin/stdout references, raw-mode state, NODE_OPTIONS, and
 * provider value, and never copies, hashes, or logs the values themselves.
 * Rather than duplicate that implementation, this module re-exports the shared
 * single fixture so the POSIX preload and acceptance test depend on an
 * explicitly POSIX-owned path while reusing one implementation.
 *
 * The preload calls these functions at activation and at exit; the POSIX
 * acceptance test exercises exact, corrupted, unrestored-raw-mode, and
 * provider-drift cases directly.
 */

module.exports = require('./session-host-windows-launcher-restoration.cjs');
