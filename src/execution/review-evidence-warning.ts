/** Recognize retained worker evidence warnings for delivery/presentation only.
 * No method, origin, or verdict is inferred or rewritten: show the original
 * warning from the worker's bounded outcome, including the shared method label.
 */
export function isWorkerReviewEvidenceWarning(line: string): boolean {
  return /\bWARNING:\s*(?:Isolated worktree|InPlace|In-place)\b/i.test(line)
    || line.includes("WARNING: Review evidence method: tool-only");
}
