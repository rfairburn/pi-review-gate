/**
 * Direct operating-mode cycling hotkey (issue #20). The registered handler
 * advances the canonical persisted mode by one (wrapping, no selector and no
 * confirmation popup), persists it through the shared settings write path,
 * and then runs the single shared operating-mode transition (status
 * indicator, notice, deferred tool reapply). It changes only the operating
 * mode: reviewer selections, captured work, and running subtasks are
 * untouched. There is deliberately no model-facing tool for changing modes.
 */
import { type OperatingMode, type ReviewGateConfig } from "./config";
import { findOccupiedHostBindings } from "./host-keybindings";
import { nextOperatingMode } from "./operating-mode";
import { sendNotice } from "./pi";
import { updateReviewGateConfig } from "./settings/persistence";

export interface ModeCycleShortcutInput {
  pi: unknown;
  config: ReviewGateConfig;
  configPath?: string;
  /** The single shared operating-mode transition used by settings saves. */
  applyModeTransition: (previous: OperatingMode, noticeTarget: unknown) => Promise<void>;
}

/** Describe the cycle without implying a popup: the hotkey advances directly. */
const CYCLE_DESCRIPTION = "Cycle the review gate operating mode directly (execute → orchestrate → plan-research → execute)";

export function registerModeCycleShortcut(input: ModeCycleShortcutInput): boolean {
  if (
    !isRecord(input.pi)
    || typeof input.pi.registerShortcut !== "function"
    || !isRecord(input.config)
    || typeof input.config.modeCycleShortcut !== "string"
  ) {
    return false;
  }
  const shortcut = input.config.modeCycleShortcut;
  const occupancy = findOccupiedHostBindings(shortcut);
  if (occupancy.resolved && occupancy.bindings.length > 0) {
    // Never steal a known host binding: the colliding built-in bindings are
    // named and the hotkey is simply not registered, so the built-in action
    // keeps working exactly as before. Conflicts with other extensions are
    // not detectable here (Pi reports those itself at startup) and are not
    // claimed to be.
    void sendNotice(
      input.pi,
      `review gate: mode cycle hotkey '${shortcut}' is also used by built-in Pi binding(s) (${occupancy.bindings.join(", ")}); the hotkey was not registered — pick a different key in /review-settings (it takes effect after /reload)`,
    );
    return false;
  }
  input.pi.registerShortcut(shortcut, {
    description: CYCLE_DESCRIPTION,
    handler: async (ctx: unknown) => {
      await enqueueCycle(input, ctx);
    },
  });
  return true;
}

/**
 * Serialize the complete cycle operation, not just the file write: the
 * canonical mode is read only when the operation starts, and the persist →
 * replace → transition sequence finishes before the next press is processed.
 * Without this, two overlapping presses both read the same starting mode and
 * both persist the same next mode, losing an advance. `config` remains the
 * sole mode state; the queue only orders operations.
 */
function enqueueCycle(input: ModeCycleShortcutInput, noticeTarget: unknown): Promise<void> {
  const run = pendingCycle.then(() => cycleOperatingMode(input, noticeTarget));
  pendingCycle = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

let pendingCycle: Promise<void> = Promise.resolve();

async function cycleOperatingMode(input: ModeCycleShortcutInput, noticeTarget: unknown): Promise<void> {
  const previous = input.config.operatingMode;
  const next = nextOperatingMode(previous);
  if (!input.configPath) {
    await sendNotice(noticeTarget, "review gate: no persistent review-gate config file is loaded; operating mode not changed");
    return;
  }
  let saved: ReviewGateConfig;
  try {
    saved = await updateReviewGateConfig(input.configPath, (parsed) => {
      parsed.operatingMode = next;
    });
  } catch (error) {
    await sendNotice(
      noticeTarget,
      `review gate: operating mode cycle could not be persisted; mode unchanged (${error instanceof Error ? error.message : String(error)})`,
    );
    return;
  }
  input.config.operatingMode = saved.operatingMode;
  await input.applyModeTransition(previous, noticeTarget);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
