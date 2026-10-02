/**
 * Missing-installed-host gate shared by the two real-host tool-card suites
 * (tests/tool-result-hints-host.test.ts, tests/subtask-dispatch-host-lifecycle.test.ts),
 * whose installed-Pi discovery lives locally in each file.
 *
 * Contract (identical to the established skip-or-fail gate in
 * tests/bridge-fakes.ts `skipOrFail`): without a resolvable installed host the
 * suites keep an honest, reason-bearing local skip for optional environments,
 * but when `PI_REVIEW_GATE_REQUIRE_PI_HOST` is exactly "1" the placeholder
 * instead fails and names the required missing Pi host — required-host runs
 * (the CI full suite) must fail clearly rather than silently degrade to a
 * skip. Test-only: production sources and runtime behavior are untouched.
 */
import test from "node:test";

/**
 * True only when the established required-host flag is carried as the exact
 * value "1" (any other preset, including "0", stays an optional environment).
 */
export function piHostRequired(): boolean {
  return process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1";
}

/**
 * The gated failure for a suite whose installed Pi host prerequisite cannot
 * resolve: the established skipOrFail wording naming the required missing Pi
 * host, plus the documented pinned-runtime hint when
 * `PI_REVIEW_GATE_INSTALLED_AGENT` points the suite at a specific install.
 */
export function missingHostError(reason: string): Error {
  const pinned = process.env.PI_REVIEW_GATE_INSTALLED_AGENT;
  const hint = pinned
    ? ` (pinned package: ${pinned}; check its package.json, dist/index.js, and pi-tui dependency)`
    : "";
  return new Error(`required Pi host unavailable: ${reason}${hint}`);
}

/**
 * Registers a suite's missing-installed-host placeholder test: the honest
 * skip with the suite's own reason, or — under the required-host gate — a
 * failing placeholder that names the required missing Pi host. The placeholder
 * name stays the same in both modes so suite runs remain comparable.
 */
export function registerMissingHostPlaceholder(name: string, reason: string): void {
  if (piHostRequired()) {
    test(name, () => {
      throw missingHostError(reason);
    });
  } else {
    test(name, { skip: reason }, () => {});
  }
}