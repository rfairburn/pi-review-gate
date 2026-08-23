/*
 * Derived from Little Coder's subagent process termination helper.
 * Copyright 2026 Itay Inbar. Licensed under Apache-2.0.
 * Modified for pi-review-gate; see NOTICE and LICENSES/Apache-2.0.txt.
 */

import type { ChildProcess } from "node:child_process";

/** Escalate SIGTERM to SIGKILL unless the child has actually exited. */
export function scheduleForceKill(
  proc: Pick<ChildProcess, "kill">,
  hasExited: () => boolean,
  delayMs = 4000,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    try {
      if (!hasExited()) proc.kill("SIGKILL");
    } catch {
      /* process already exited */
    }
  }, delayMs);
}
