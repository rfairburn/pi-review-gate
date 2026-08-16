export type TerminalSafetyCode =
  | "user_cancelled"
  | "concurrent_executor_detected"
  | "workspace_ownership_or_path_escape"
  | "recovery_state_corrupt_or_unverifiable"
  | "integration_or_landing_state_uncertain"
  | "landing_rollback_incomplete"
  | "authorization_boundary_violation";

export interface TerminalSafetyRule {
  code: TerminalSafetyCode;
  critical: boolean;
  automaticRetry: false;
  retainArtifacts: boolean;
  explanation: string;
  safeActions: readonly string[];
}

const rules: Record<TerminalSafetyCode, TerminalSafetyRule> = {
  user_cancelled: rule("user_cancelled", false, "The user cancelled the operation.", ["inspect"]),
  concurrent_executor_detected: rule("concurrent_executor_detected", true, "Another writer may own the worker.", ["inspect"]),
  workspace_ownership_or_path_escape: rule("workspace_ownership_or_path_escape", true, "Workspace identity or containment could not be proven.", ["inspect"]),
  recovery_state_corrupt_or_unverifiable: rule("recovery_state_corrupt_or_unverifiable", true, "The recovery checkpoint could not be created or verified.", ["inspect"]),
  integration_or_landing_state_uncertain: rule("integration_or_landing_state_uncertain", true, "Integration or landing ownership is uncertain.", ["inspect"]),
  landing_rollback_incomplete: rule("landing_rollback_incomplete", true, "Landing rollback did not restore a proven source state.", ["inspect"]),
  authorization_boundary_violation: rule("authorization_boundary_violation", true, "Recovery would cross an authorization boundary.", ["inspect"]),
};

export function terminalSafetyRule(code: TerminalSafetyCode): TerminalSafetyRule {
  return rules[code];
}

export function isTerminalSafetyCode(value: string): value is TerminalSafetyCode {
  return Object.hasOwn(rules, value);
}

function rule(code: TerminalSafetyCode, critical: boolean, explanation: string, safeActions: readonly string[]): TerminalSafetyRule {
  return { code, critical, automaticRetry: false, retainArtifacts: true, explanation, safeActions };
}
