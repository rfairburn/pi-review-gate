import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNativeEditorFieldEmpty,
  borderedEditorContentMatches,
  classifyFirstWorkspaceEnter,
  readBorderedEditorContent,
  sameFileIdentity,
  windowsDirectoryCompletionCandidates,
  validateWindowsExitWitness,
  type WindowsWitnessExpectation,
} from "./helpers/session-host-native-windows-contracts";

const READY_EXPECTATION: WindowsWitnessExpectation = {
  requestNonce: "nonce_0123456789abcdef01234567",
  observerPid: 4210,
  nativePid: 7312,
  state: "READY",
};
const EXIT_EXPECTATION: WindowsWitnessExpectation = { ...READY_EXPECTATION, state: "exited" };
const TICKS = "638564000000000000";

function witness(state: "READY" | "exited", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requestNonce: READY_EXPECTATION.requestNonce,
    observerPid: READY_EXPECTATION.observerPid,
    nativePid: READY_EXPECTATION.nativePid,
    nativeCreationTimeUtcTicks: TICKS,
    state,
    ...(state === "exited" ? { exitCode: 0 } : {}),
    ...overrides,
  };
}

test("Windows native helper contract validates exact READY and retained exited witnesses", () => {
  const ready = validateWindowsExitWitness(witness("READY"), READY_EXPECTATION);
  assert.equal(ready.state, "READY");
  assert.equal(ready.nativeCreationTimeUtcTicks, TICKS, "creation ticks remain an exact decimal string, never a Number");
  const exited = validateWindowsExitWitness(witness("exited"), EXIT_EXPECTATION);
  assert.equal(exited.state, "exited");
  assert.equal(exited.exitCode, 0, "only the kernel-handle exited/zero result is accepted");
});

test("Windows native helper contract rejects schema, nonce, PID, ticks, and non-exit acknowledgements", () => {
  assert.throws(() => validateWindowsExitWitness(null, READY_EXPECTATION), /JSON object/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { schemaVersion: 2 }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { requestNonce: "other_nonce_0123456789" }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { observerPid: 4211 }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativePid: 7313 }), READY_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: "" }), READY_EXPECTATION), /creation ticks/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: 638564000000000000 }), READY_EXPECTATION), /creation ticks/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: "0638564000000000000" }), READY_EXPECTATION), /creation ticks/);
  assert.throws(() => validateWindowsExitWitness(witness("READY", { nativeCreationTimeUtcTicks: "9999999999999999999" }), READY_EXPECTATION), /DateTime range/);
  assert.throws(() => validateWindowsExitWitness(witness("exited"), READY_EXPECTATION), /schema shape/);
  assert.throws(() => validateWindowsExitWitness(witness("exited", { exitCode: 1 }), EXIT_EXPECTATION), /exit code zero/);
  assert.throws(() => validateWindowsExitWitness(witness("exited", { state: "requested" }), EXIT_EXPECTATION), /nonce\/PID\/state/);
  assert.throws(() => validateWindowsExitWitness(witness("exited", { result: "acknowledged" }), EXIT_EXPECTATION), /schema shape/);
});

test("Windows native helper contract compares filesystem identities without Number coercion", () => {
  const same = { dev: 9_007_199_254_740_993n, ino: 9_007_199_254_740_997n };
  assert.equal(sameFileIdentity(same, { ...same }), true);
  assert.equal(sameFileIdentity(same, { dev: same.dev + 1n, ino: same.ino }), false);
  assert.equal(sameFileIdentity(same, { dev: same.dev, ino: same.ino + 1n }), false);
});

function publicEditorFrame(
  fieldLabel: "> Workspace:" | "> New name:",
  bodyRows: readonly string[],
  width = 24,
): string {
  const indent = "     ";
  const prefix = `${fieldLabel} `;
  const bodyIndent = `${indent}${" ".repeat(prefix.length)}`;
  const rule = "─".repeat(width);
  return [
    "Session host · Welcome",
    `${indent}${prefix}${rule}`,
    ...bodyRows.map((row) => `${bodyIndent}${row.padEnd(width)}`),
    `${bodyIndent}${rule}`,
  ].join("\n");
}

test("Windows native helper contract parses the pinned Editor's horizontal rules and complete empty bodies", () => {
  const workspace = publicEditorFrame("> Workspace:", [""]);
  assert.equal(readBorderedEditorContent(workspace, "> Workspace:"), "");
  assertNativeEditorFieldEmpty(workspace, "> Workspace:");

  const edit = publicEditorFrame("> New name:", [""]);
  assertNativeEditorFieldEmpty(edit, "> New name:");
  assert.throws(() => assertNativeEditorFieldEmpty(publicEditorFrame("> Workspace:", ["draft"]), "> Workspace:"), /not empty/);
  assert.throws(() => assertNativeEditorFieldEmpty(" > Workspace: ", "> Workspace:"), /horizontal top rule/);
  assert.throws(() => assertNativeEditorFieldEmpty(`${workspace.split("\n").slice(0, -1).join("\n")}\n`, "> Workspace:"), /horizontal bottom rule/);
});

test("Windows native helper contract observes an exact typed workspace across a suffix-splitting wrap", () => {
  const workspace = "C:\\owned\\" + "x".repeat(64) + "\\a";
  const frame = publicEditorFrame("> Workspace:", [workspace.slice(0, 73), workspace.slice(73)], 74);
  assert.equal(frame.includes(workspace.slice(-18)), false);
  assert.equal(borderedEditorContentMatches(frame, "> Workspace:", workspace), true);
  const partial = publicEditorFrame("> Workspace:", [workspace.slice(0, 73), workspace.slice(73, -1)], 74);
  assert.equal(borderedEditorContentMatches(partial, "> Workspace:", workspace), false);
});

test("Windows native helper contract reconstructs wrapped Editor rows and forward-slash completion display", () => {
  const expected = windowsDirectoryCompletionCandidates("C:\\owned\\project");
  assert.equal(expected[0], "C:/owned/project/");
  const wrappedRows = ["C:/owned", "/project", "/"];
  const frame = publicEditorFrame("> Workspace:", wrappedRows, 9);
  assert.equal(readBorderedEditorContent(frame, "> Workspace:"), expected[0]);
  assert.equal(borderedEditorContentMatches(frame, "> Workspace:", expected), true);
  assert.deepEqual(classifyFirstWorkspaceEnter(frame, expected), {
    state: "folder-completed",
    acceptedPath: expected[0],
  });

  const quotedExpected = windowsDirectoryCompletionCandidates("C:\\Owned Space\\project");
  const quotedFrame = publicEditorFrame("> Workspace:", ['"C:/Owned ', 'Space/project/"'], 20);
  assert.equal(borderedEditorContentMatches(quotedFrame, "> Workspace:", quotedExpected), true,
    "wrapped native quoting and a word-boundary space are accepted only around the exact owned completion");
  assert.deepEqual(classifyFirstWorkspaceEnter("Session host · Starting (request 1)", expected), { state: "submitted" });
  assert.deepEqual(classifyFirstWorkspaceEnter("Session host · Welcome", expected), { state: "submitted" });
  assert.throws(() => classifyFirstWorkspaceEnter(frame, windowsDirectoryCompletionCandidates("C:\\owned\\other")),
    /exact owned forward-slash directory completion/);
});
