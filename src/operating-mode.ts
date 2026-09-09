/**
 * Operating-mode prompt segments. The extension owns the mode-specific system
 * prompt segment (the launcher no longer bakes one in with
 * --append-system-prompt), so a settings or hotkey transition only changes
 * which packaged segment the next agent run receives: each run's prompt is
 * built fresh from the base prompt plus the current mode segment, and no old
 * mode text can survive because nothing persists it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATING_MODES, type OperatingMode } from "./config";

export const OPERATING_MODE_SEGMENT_FILES: Record<OperatingMode, string> = {
  execute: "execution-system-prompt.md",
  orchestrate: "orchestrator-system-prompt.md",
  "plan-research": "planning-system-prompt.md",
};

export const OPERATING_MODE_LABELS: Record<OperatingMode, string> = {
  execute: "Prefer execution",
  orchestrate: "Prefer orchestration",
  "plan-research": "Plan/research",
};

/** Load the mode segments from the packaged scripts directory. */
export function loadOperatingModeSegments(scriptsDir: string): Record<OperatingMode, string> {
  const segments = {} as Record<OperatingMode, string>;
  for (const mode of Object.keys(OPERATING_MODE_SEGMENT_FILES) as OperatingMode[]) {
    segments[mode] = readFileSync(join(scriptsDir, OPERATING_MODE_SEGMENT_FILES[mode]), "utf8");
  }
  return segments;
}

/**
 * Direct mode cycling (issue #20): the canonical declaration order wraps
 * execute → orchestrate → plan-research → execute with no selector or
 * confirmation popup.
 */
export function nextOperatingMode(current: OperatingMode): OperatingMode {
  const index = OPERATING_MODES.indexOf(current);
  return OPERATING_MODES[(index + 1) % OPERATING_MODES.length]!;
}
