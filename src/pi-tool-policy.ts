/**
 * Pi's tool-policy launch flags, grouped by meaning: the long spelling and its
 * short alias. The single source for every review-gate check that recognizes
 * these flags; a check never derives a flag's VALUE from this table (Pi's own
 * parser owns operand boundaries).
 */
export const PI_TOOL_POLICY_FLAG_ALIASES = {
  allowlist: ["--tools", "-t"],
  exclude: ["--exclude-tools", "-xt"],
  noTools: ["--no-tools", "-nt"],
  noBuiltinTools: ["--no-builtin-tools", "-nbt"],
} as const;

export type PiToolPolicyFlagKind = keyof typeof PI_TOOL_POLICY_FLAG_ALIASES;

const PI_TOOL_POLICY_FLAG_KINDS = new Map<string, PiToolPolicyFlagKind>(
  (Object.entries(PI_TOOL_POLICY_FLAG_ALIASES) as Array<[PiToolPolicyFlagKind, readonly string[]]>)
    .flatMap(([kind, flags]) => flags.map((flag) => [flag, kind] as const)),
);

/**
 * The tool-policy flag kind one argument token spells, bare or with an
 * attached `=value`, or undefined. Token-local: it does not know whether the
 * token is an option, another option's value, or message data.
 */
export function piToolPolicyFlagKind(arg: string): PiToolPolicyFlagKind | undefined {
  const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
  return PI_TOOL_POLICY_FLAG_KINDS.get(flag);
}

export function assertNoPiToolPolicyArgs(args: readonly string[], context: string): void {
  const conflicting = args.find((arg) => piToolPolicyFlagKind(arg) !== undefined);
  if (conflicting) {
    throw new Error(`${context} must not set ${conflicting}; tool access is supplied by the harness through one native --tools allowlist.`);
  }
}
