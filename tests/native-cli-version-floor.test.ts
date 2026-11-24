import assert from "node:assert/strict";
import test from "node:test";

import { CLAUDE_INBOX_MIN_CLI_VERSION, isClaudeInboxSupportedCliVersion } from "../src/session-host/native-claude-inbox-delivery";
import { isStableCliVersionAtLeast, parseStableCliVersion } from "../src/session-host/native-cli-version-floor";
import { CODEX_CALLBACK_MIN_CLI_VERSION, isCodexCallbackSupportedCliVersion } from "../src/session-host/native-codex-version-probe";
import { NATIVE_MCP_CLAUDE_CLEAR_RECOVERY_MIN_CLI_VERSION } from "../src/session-host/instances";

/**
 * #682: the strict stable-version floor comparator behind managed callback
 * eligibility. Pure and portable: no process, file, or provider is touched.
 * Admitting a version here is a compatibility floor only; it is not a claim
 * that any untested release works.
 */

test("the floors are the tested baselines: Claude Code 2.1.330 and Codex 0.171.0", () => {
  assert.equal(CLAUDE_INBOX_MIN_CLI_VERSION, "2.1.330");
  assert.equal(NATIVE_MCP_CLAUDE_CLEAR_RECOVERY_MIN_CLI_VERSION, "2.1.330");
  assert.equal(CODEX_CALLBACK_MIN_CLI_VERSION, "0.171.0");
});

test("parses only well-formed stable triples with bounded numeric components", () => {
  assert.deepEqual(parseStableCliVersion("2.1.330"), [2, 1, 330]);
  assert.deepEqual(parseStableCliVersion("0.0.0"), [0, 0, 0]);
  assert.deepEqual(parseStableCliVersion("999999.999999.999999"), [999999, 999999, 999999]);
  assert.equal(Object.isFrozen(parseStableCliVersion("0.171.0")), true);
  for (const malformed of [
    "", "2", "2.1", "2.1.330.0", "2..330", ".1.330", "2.1.", "2.1.330.",
    "v2.1.330", "V2.1.330", "=2.1.330", ">=2.1.330", "~2.1.330", "^2.1.330",
    "2.1.330-beta", "2.1.330-0", "2.1.330-rc.1", "2.1.330+build", "2.1.330+20260101", "2.1.330-alpha+build",
    "02.1.330", "2.01.330", "2.1.0330", "00.0.0", "0.00.0", "0.0.00",
    "1234567.0.0", "0.1234567.0", "0.0.1234567",
    " 2.1.330", "2.1.330 ", "2.1.330\n", "2.1.330\r\n", "\t2.1.330", "2.1.330\u0000",
    "2.1.330 (Claude Code)", "codex-cli 0.171.0", "2.1.x", "2.1.*", "-2.1.330", "2.-1.330",
    "２.1.330", "2.1.33٠", "2.1.330​",
  ]) {
    assert.equal(parseStableCliVersion(malformed), undefined, JSON.stringify(malformed));
  }
  for (const nonString of [undefined, null, 2, 2.1, true, {}, ["2", "1", "330"], Symbol("v")]) {
    assert.equal(parseStableCliVersion(nonString), undefined, String(nonString));
  }
});

test("orders numerically by major, then minor, then patch", () => {
  const floor = "2.1.330";
  // Exactly the floor and anything above it at each position.
  for (const above of ["2.1.330", "2.1.331", "2.1.1000", "2.1.999999", "2.2.0", "2.10.0", "3.0.0", "10.0.0", "999999.0.0"]) {
    assert.equal(isStableCliVersionAtLeast(above, floor), true, above);
  }
  // Below at each position, including lexicographic traps ("2.1.4" > "2.1.330" as strings).
  for (const below of ["2.1.329", "2.1.33", "2.1.4", "2.1.0", "2.0.999999", "1.999999.999999", "0.0.0"]) {
    assert.equal(isStableCliVersionAtLeast(below, floor), false, below);
  }
  assert.equal(isStableCliVersionAtLeast("0.171.0", "0.171.0"), true);
  assert.equal(isStableCliVersionAtLeast("0.99.0", "0.171.0"), false, "0.99 < 0.171 numerically");
  assert.equal(isStableCliVersionAtLeast("0.1000.0", "0.171.0"), true);
  assert.equal(isStableCliVersionAtLeast("1.0.0", "0.171.0"), true);
});

test("a malformed observed version or floor admits nothing", () => {
  for (const observed of ["2.1.331-beta", "2.1.331+build", "02.1.331", "v3.0.0", "3.0", "", undefined]) {
    assert.equal(isStableCliVersionAtLeast(observed, "2.1.330"), false, JSON.stringify(observed));
  }
  for (const floor of ["", "2.1", "2.1.330-beta", "v2.1.330", "02.1.330"]) {
    assert.equal(isStableCliVersionAtLeast("9.9.9", floor), false, JSON.stringify(floor));
  }
});

test("both provider predicates apply the same grammar to their own floor", () => {
  const cases: [string, boolean, boolean][] = [
    // [version, Claude (>= 2.1.330), Codex (>= 0.171.0)]
    ["0.170.999", false, false],
    ["0.171.0", false, true],
    ["0.172.0", false, true],
    ["2.1.329", false, true],
    ["2.1.330", true, true],
    ["2.2.0", true, true],
    ["3.0.0", true, true],
    ["3.0.0-rc.1", false, false],
    ["3.0.0+build", false, false],
    ["03.0.0", false, false],
  ];
  for (const [version, claude, codex] of cases) {
    assert.equal(isClaudeInboxSupportedCliVersion(version), claude, `claude ${version}`);
    assert.equal(isCodexCallbackSupportedCliVersion(version), codex, `codex ${version}`);
  }
});
