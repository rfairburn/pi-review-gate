/** Pure, runtime-independent contracts shared by the Windows native test harness. */

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface WindowsWitnessExpectation {
  readonly requestNonce: string;
  readonly observerPid: number;
  readonly nativePid: number;
  readonly state: "READY" | "exited";
}

export interface WindowsExitWitness {
  readonly schemaVersion: 1;
  readonly requestNonce: string;
  readonly observerPid: number;
  readonly nativePid: number;
  readonly nativeCreationTimeUtcTicks: string;
  readonly state: "READY" | "exited";
  readonly exitCode?: number;
}

export type FirstWorkspaceEnterObservation =
  | { readonly state: "folder-completed"; readonly acceptedPath: string }
  | { readonly state: "submitted" };

const MAX_DOTNET_DATE_TICKS = 3_155_378_975_999_999_999n;

/** Strict schema, nonce, exact PID, state, and lossless decimal tick validation. */
export function validateWindowsExitWitness(value: unknown, expected: WindowsWitnessExpectation): WindowsExitWitness {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Windows exit-watcher witness is not a JSON object");
  }
  const witness = value as Record<string, unknown>;
  const expectedKeys = expected.state === "exited"
    ? ["schemaVersion", "requestNonce", "observerPid", "nativePid", "nativeCreationTimeUtcTicks", "state", "exitCode"]
    : ["schemaVersion", "requestNonce", "observerPid", "nativePid", "nativeCreationTimeUtcTicks", "state"];
  const keys = Object.keys(witness).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (keys.length !== sortedExpectedKeys.length || keys.some((key, index) => key !== sortedExpectedKeys[index])) {
    throw new Error("Windows exit-watcher witness has an unexpected schema shape");
  }
  if (witness.schemaVersion !== 1 || witness.state !== expected.state
    || witness.requestNonce !== expected.requestNonce
    || witness.observerPid !== expected.observerPid || witness.nativePid !== expected.nativePid) {
    throw new Error("Windows exit-watcher witness did not match its exact nonce/PID/state request");
  }
  if (typeof witness.nativeCreationTimeUtcTicks !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(witness.nativeCreationTimeUtcTicks)) {
    throw new Error("Windows exit-watcher witness has no exact positive decimal creation ticks");
  }
  const ticks = BigInt(witness.nativeCreationTimeUtcTicks);
  if (ticks <= 0n || ticks > MAX_DOTNET_DATE_TICKS) {
    throw new Error("Windows exit-watcher creation ticks are outside the exact .NET DateTime range");
  }
  if (expected.state === "exited" && (!Number.isInteger(witness.exitCode) || witness.exitCode !== 0)) {
    throw new Error("Windows exit-watcher result did not observe native exit code zero");
  }
  return witness as unknown as WindowsExitWitness;
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The pinned Editor draws horizontal rules and unboxed, possibly wrapped content rows. */
interface NativeEditorContent {
  readonly rows: readonly string[];
}

const HORIZONTAL_RULE = "─";

function readNativeEditorContent(frame: string, fieldLabel: "> Workspace:" | "> New name:"): NativeEditorContent {
  const lines = frame.split("\n");
  const prefix = `${fieldLabel} `;
  let labelRow = -1;
  let labelColumn = -1;
  let fieldColumn = -1;
  let fieldWidth = 0;

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row]!;
    const candidateLabelColumn = line.indexOf(fieldLabel);
    if (candidateLabelColumn < 0 || line.slice(candidateLabelColumn, candidateLabelColumn + prefix.length) !== prefix) continue;
    const column = candidateLabelColumn + prefix.length;
    const border = /^─+/.exec(line.slice(column))?.[0];
    if (!border) continue;
    labelRow = row;
    labelColumn = candidateLabelColumn;
    fieldColumn = column;
    fieldWidth = border.length;
    break;
  }

  if (labelRow < 0 || fieldWidth < 1) {
    throw new Error(`public native Editor ${fieldLabel} has no visible horizontal top rule at its field column`);
  }

  // The Editor may wrap one logical value over several unboxed rows. Use the
  // matching bottom rule, not an assumed single content row or corner glyph.
  let bottomRow = -1;
  const rule = HORIZONTAL_RULE.repeat(fieldWidth);
  for (let row = labelRow + 1; row < lines.length; row += 1) {
    if (lines[row]!.slice(fieldColumn, fieldColumn + fieldWidth) === rule) bottomRow = row;
  }
  if (bottomRow <= labelRow + 1) {
    throw new Error(`public native Editor ${fieldLabel} has no complete horizontal bottom rule and content body`);
  }

  const rows: string[] = [];
  for (let row = labelRow + 1; row < bottomRow; row += 1) {
    const line = lines[row]!;
    if (line.slice(labelColumn, fieldColumn).trim() !== "") {
      throw new Error(`public native Editor ${fieldLabel} content is not aligned under its visible field column`);
    }
    const content = line.slice(fieldColumn, fieldColumn + fieldWidth);
    if (content.length !== fieldWidth) {
      throw new Error(`public native Editor ${fieldLabel} content row is clipped`);
    }
    rows.push(content);
  }
  return { rows };
}

/** Return the visible body rows joined without renderer-added right padding. */
export function readBorderedEditorContent(frame: string, fieldLabel: "> Workspace:" | "> New name:"): string {
  return readNativeEditorContent(frame, fieldLabel).rows.map((row) => row.trimEnd()).join("");
}

export function borderedEditorContentMatches(
  frame: string,
  fieldLabel: "> Workspace:" | "> New name:",
  expectedValues: string | readonly string[],
): boolean {
  const expected = typeof expectedValues === "string" ? [expectedValues] : expectedValues;
  const body = readNativeEditorContent(frame, fieldLabel).rows;
  let prefixes = new Set<string>([""]);
  for (const row of body) {
    const firstPossibleEnd = row.trimEnd().length;
    const nextPrefixes = new Set<string>();
    for (const prefix of prefixes) {
      for (let end = firstPossibleEnd; end <= row.length; end += 1) {
        const candidate = prefix + row.slice(0, end);
        if (expected.some((value) => value.startsWith(candidate))) nextPrefixes.add(candidate);
      }
    }
    prefixes = nextPrefixes;
    if (prefixes.size === 0) return false;
  }
  return expected.some((value) => prefixes.has(value));
}

export function windowsDirectoryCompletionCandidates(canonicalWorkspace: string): string[] {
  const displayPath = canonicalWorkspace.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!displayPath || !/^(?:[A-Za-z]:\/|\/\/)/.test(displayPath)) {
    throw new Error("Windows directory completion requires an absolute drive or UNC path");
  }
  const completion = `${displayPath}/`;
  // The native autocomplete may quote paths that need shell-safe display.
  return [...new Set([completion, `"${completion}"`, `'${completion}'`])];
}

export function assertNativeEditorFieldEmpty(frame: string, fieldLabel: "> Workspace:" | "> New name:"): void {
  if (readNativeEditorContent(frame, fieldLabel).rows.some((row) => row.trim() !== "")) {
    throw new Error(`public native Editor ${fieldLabel} was not empty in its complete visible content body`);
  }
}

/** Distinguish accepting a real directory completion from submitting the New form. */
export function classifyFirstWorkspaceEnter(
  frame: string,
  expectedOwnedDirectoryCompletions: string | readonly string[],
): FirstWorkspaceEnterObservation {
  if (frame.includes("Starting (request ") || !frame.includes("Workspace:")) {
    return { state: "submitted" };
  }
  const candidates = typeof expectedOwnedDirectoryCompletions === "string"
    ? [expectedOwnedDirectoryCompletions]
    : expectedOwnedDirectoryCompletions;
  const acceptedPath = candidates.find((candidate) =>
    borderedEditorContentMatches(frame, "> Workspace:", candidate));
  if (acceptedPath === undefined) {
    throw new Error("first Workspace Enter did not accept the exact owned forward-slash directory completion");
  }
  return { state: "folder-completed", acceptedPath };
}
