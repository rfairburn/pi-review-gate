import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const SKILL_RELATIVE_PATH = ["skills", "pi-review-gate-completion", "SKILL.md"] as const;

/**
 * Resolve the shipped completion skill using the launcher's installed location
 * first, then the skill bundled with the extension package. `extensionDirectory`
 * is injectable to keep path selection deterministic in tests.
 */
export function resolveCompletionSkillPath(
  extensionDirectory: string = __dirname,
  homeDirectory: string = homedir(),
): string | undefined {
  const candidates = [
    join(homeDirectory, ".agents", "skills", "pi-review-gate-completion", "SKILL.md"),
    resolve(extensionDirectory, "..", "..", "..", ...SKILL_RELATIVE_PATH),
    resolve(extensionDirectory, "..", "..", ...SKILL_RELATIVE_PATH),
    resolve(extensionDirectory, "..", ...SKILL_RELATIVE_PATH),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** Prompt only when the installed/package skill can actually be read. */
export function buildCompletionGuidancePrompt(skillPath: string | undefined): string | undefined {
  if (!skillPath) return undefined;
  return `At a meaningful completion point for substantial work, read and follow the installed pi-review-gate-completion skill at ${JSON.stringify(skillPath)}. When YouShouldKnow is available and otherwise authorized, publish a substantial, factual handoff there and still provide your normal concise conversation summary. Include outcomes, consequential decisions, actual verification and status, actionable manual test steps when useful, and limitations; explicitly mark pending or failed work, never imply it passed, and do not infer authority from this guidance.`;
}
