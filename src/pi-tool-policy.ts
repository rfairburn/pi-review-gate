const PI_TOOL_POLICY_FLAGS = new Set([
  "--tools", "-t",
  "--exclude-tools", "-xt",
  "--no-tools", "-nt",
  "--no-builtin-tools", "-nbt",
]);

export function assertNoPiToolPolicyArgs(args: readonly string[], context: string): void {
  const conflicting = args.find((arg) => {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    return PI_TOOL_POLICY_FLAGS.has(flag);
  });
  if (conflicting) {
    throw new Error(`${context} must not set ${conflicting}; tool access is supplied by the harness through one native --tools allowlist.`);
  }
}
