/**
 * Test-only #446 causal experiment for the native Windows lineage proof
 * (Refs #446: diagnosis plus verification of the module-binding correction; the
 * historical timeout's cause is still unproven).
 *
 * One required Windows run timed out on the genuine-descendant proof after the
 * script entered its initial CIM request and before that request returned. The
 * existing marker-only phase probe (`windows-lineage-phase-diagnostics.ts`) can
 * only bracket that whole statement. This helper runs ONE fixed two-arm
 * experiment on the same production verifier.
 *
 * Version 1 compared an inherited environment against a test-side copy without
 * `PSModulePath`. Its native run showed the inherited child binding
 * `Get-CimInstance` to a `CimCmdlets` module outside the native Windows
 * PowerShell 5.1 system modules (`cim-elsewhere`) and the cleared child binding
 * the native one (`native-cim`), with both arms fast. Production now builds that
 * copy itself ({@link windowsLineageQueryEnvironment}), so version 2 is:
 *
 * - `inherited` is the LEGACY CONTROL: it overrides the producer's environment
 *   with the original parent environment (`parentEnv`, default `process.env`),
 *   reproducing what the query child received before the correction. It is a
 *   deliberate override, never production delegation.
 * - `child-scoped` is the CORRECTED arm: it forwards the producer's query options
 *   verbatim, including the environment production actually built. The probe
 *   applies no normalization of its own, so a producer that dropped the
 *   correction would launch this arm with `PSModulePath` and be reported.
 *
 * Both arms run the same production-emitted script with the same added passive
 * instrument: a child-local `Stopwatch` and the public
 * `$ExecutionContext.InvokeCommand.PreCommandLookupAction` /
 * `PostCommandLookupAction` delegates, filtered to the literal `Get-CimInstance`
 * name. The delegates never assign `Command`, `CommandScriptBlock`, or
 * `StopSearch`, never emit output, and invoke no command (no cmdlet, function,
 * or alias), so the observer itself causes no command discovery. They write fixed
 * stderr frames only; stdout keeps carrying exactly the proof bytes.
 *
 * For the two positive verifications the first outer target pre-lookup also waits
 * on the query child's own stdin for one fixed release token. The coordinator
 * ({@link createWindowsLineageReleaseGate}) writes that token to both children
 * only after BOTH reported they reached that lookup, so neither positive child's
 * command discovery may start before the other is equally far along. The gate
 * waits inside the verifier's unchanged 5s deadline, has its own smaller bound,
 * and is recorded separately: a gate that expires, loses a party, or is
 * acknowledged with anything but the exact token makes the experiment INVALID,
 * never evidence of the historical timeout.
 *
 * Status vocabulary is deliberately separate from the marker-only probe: this is
 * not production delegation (the script differs for both arms, and the legacy
 * control's environment is overridden), so it never reports
 * `delegation=production`; the `treatment=` token names which environment ran. Output is one bounded line of
 * closed-vocabulary tokens and bounded integers: no PID, path, environment value,
 * command, script, error text, CommandInfo, or module inventory. Hook availability
 * and non-interference on the installed Windows PowerShell 5.1 are NOT assumed:
 * they must be validated on the native host (the win32 controls in the lineage
 * diagnostics test), and anything unsupported, swallowed, or malformed fails the
 * instrument instead of being read as a fast or slow lookup.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { win32 } from "node:path";
import { performance } from "node:perf_hooks";
import {
  MAX_QUERY_OUTPUT_BYTES,
  isWindowsLineageRefusalReason,
  type WindowsLineageQueryChild,
  type WindowsLineageQueryExecutor,
  type WindowsLineageQueryOptions,
  type WindowsLineageVerification,
} from "../../src/execution/windows-process-lineage";

export const WINDOWS_LINEAGE_CAUSAL_EXPERIMENT = "l446-psmodulepath-differential";
export const WINDOWS_LINEAGE_CAUSAL_VERSION = 2;
export const WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX = "PRG-L446:";
/** The one fixed release token a gated child accepts (followed by a newline). */
export const WINDOWS_LINEAGE_CAUSAL_RELEASE_TOKEN = "G";
/** Gate bound, counted from the first ready report; well inside the 5s query deadline. */
export const WINDOWS_LINEAGE_CAUSAL_GATE_BOUND_MS = 1_000;
/** Grew by exactly the three bounded environment fields version 2 added (51 chars at their widest). */
export const WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS = 1_251;
/** The literal command name the passive delegates observe. */
export const WINDOWS_LINEAGE_CAUSAL_TARGET_COMMAND = "Get-CimInstance";

export const WINDOWS_LINEAGE_CAUSAL_ARMS = ["inherited", "child-scoped"] as const;
export type WindowsLineageCausalArm = (typeof WINDOWS_LINEAGE_CAUSAL_ARMS)[number];
export const WINDOWS_LINEAGE_CAUSAL_ROLES = ["positive", "negative"] as const;
export type WindowsLineageCausalRole = (typeof WINDOWS_LINEAGE_CAUSAL_ROLES)[number];
/** `matched`: the pre-lookup waits for the release token. `ungated`: observation only. */
export type WindowsLineageCausalGateMode = "matched" | "ungated";
export const WINDOWS_LINEAGE_CAUSAL_TREATMENTS = ["legacy-inherited-override", "producer-env"] as const;
export type WindowsLineageCausalTreatment = (typeof WINDOWS_LINEAGE_CAUSAL_TREATMENTS)[number];

const TREATMENT_BY_ARM: Readonly<Record<WindowsLineageCausalArm, WindowsLineageCausalTreatment>> = {
  inherited: "legacy-inherited-override",
  "child-scoped": "producer-env",
};

// ---------------------------------------------------------------------------
// Closed module-path categories (observation only; production owns the env copy)
// ---------------------------------------------------------------------------

/**
 * How many keys of `env` name `PSModulePath` case-insensitively, saturating at 9.
 * This only COUNTS; the environment copy itself comes from production.
 */
export function countModulePathKeys(env: NodeJS.ProcessEnv | undefined): number {
  if (env === undefined || env === null || typeof env !== "object") return 0;
  return Math.min(9, Object.keys(env).filter((key) => key.toLowerCase() === "psmodulepath").length);
}

function modulePathValue(env: NodeJS.ProcessEnv): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === "psmodulepath")?.[1];
}

/**
 * Closed module-path categories, as four bits in this fixed order: present; a
 * PowerShell 7 default location; the native Windows PowerShell 5.1 system module
 * location (`<SystemRoot>\System32\WindowsPowerShell\v1.0\Modules`, i.e. the
 * child's `$PSHOME\Modules`); and "a PowerShell 7 default location comes before
 * the native one (or the native one is absent)". A PowerShell 7 default location
 * is an entry ending in `PowerShell\7*\Modules` (PowerShell 7's own `$PSHOME`),
 * `Documents\PowerShell\Modules` (current user), or
 * `Program Files\PowerShell\Modules` (all users); `WindowsPowerShell` entries and
 * other tools' `...\PowerShell\Modules` folders are not. The value itself is
 * never returned or retained. The child computes the same bits in PowerShell.
 */
export function classifyModulePathCategories(value: string | undefined, nativeModulesDir: string | undefined): string {
  const native = nativeModulesDir === undefined ? undefined : trimSeparators(nativeModulesDir).toLowerCase();
  const present = typeof value === "string" && value.length > 0;
  let ps7 = -1;
  let nativeAt = -1;
  let index = 0;
  for (const raw of present ? value.split(";") : []) {
    const entry = trimSeparators(raw.trim());
    if (entry.length === 0) continue;
    if (nativeAt < 0 && native !== undefined && native.length > 0 && entry.toLowerCase() === native) nativeAt = index;
    if (ps7 < 0 && isPowerShell7DefaultLocation(entry)) ps7 = index;
    index += 1;
  }
  const bit = (flag: boolean): string => (flag ? "1" : "0");
  return bit(present) + bit(ps7 >= 0) + bit(nativeAt >= 0) + bit(ps7 >= 0 && (nativeAt < 0 || ps7 < nativeAt));
}

function isPowerShell7DefaultLocation(entry: string): boolean {
  const parts = entry.split(/[\\/]/).map((part) => part.toLowerCase());
  const count = parts.length;
  if (count < 3 || parts[count - 1] !== "modules") return false;
  const [parent, folder] = [parts[count - 3]!, parts[count - 2]!];
  if (parent === "powershell" && folder.startsWith("7")) return true;
  return folder === "powershell" && (parent === "documents" || parent === "program files");
}

function trimSeparators(text: string): string {
  return text.replace(/[\\/]+$/, "");
}

/** The parent-side native module location for a validated absolute SystemRoot. */
export function nativeWindowsModulesDir(systemRoot: string | undefined): string | undefined {
  if (!systemRoot || !win32.isAbsolute(systemRoot)) return undefined;
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
}

const MODULE_PATH_BITS = /^[01]{4}$/;

// ---------------------------------------------------------------------------
// Child-side frames
// ---------------------------------------------------------------------------

/** Every frame the instrumented child may write, in canonical order. */
export const WINDOWS_LINEAGE_CAUSAL_CHILD_FRAMES = [
  "psmp",
  "hooks-installed",
  "initial-query-start",
  "lookup-ready",
  "lookup-released",
  "lookup-nested-post",
  "lookup-complete",
  "initial-query-end",
  "snapshot-start",
  "snapshot-end",
  "prelude-error",
  "hook-error",
  "lookup-unpaired",
] as const;
export type WindowsLineageCausalChildFrame = (typeof WINDOWS_LINEAGE_CAUSAL_CHILD_FRAMES)[number];

export const WINDOWS_LINEAGE_CAUSAL_LOOKUP_CLASSES = ["native-cim", "cim-elsewhere", "other", "absent"] as const;
export const WINDOWS_LINEAGE_CAUSAL_RELEASE_ACKS = ["ok", "invalid", "ungated"] as const;

/** The token grammar of each frame (`undefined`: the frame carries no token). */
const FRAME_TOKENS: Readonly<Record<WindowsLineageCausalChildFrame, RegExp | undefined>> = {
  psmp: MODULE_PATH_BITS,
  "hooks-installed": undefined,
  "initial-query-start": undefined,
  "lookup-ready": undefined,
  "lookup-released": /^(?:ok|invalid|ungated)$/,
  "lookup-complete": /^(?:native-cim|cim-elsewhere|other|absent)$/,
  /** Target pre-lookups, post-lookups (both saturating at 9), and still-open depth. */
  "initial-query-end": /^[0-9]-[0-9]-[0-9]$/,
  "lookup-nested-post": undefined,
  "lookup-unpaired": undefined,
  "snapshot-start": undefined,
  "snapshot-end": undefined,
  "prelude-error": /^(?:state|psmp|hooks)$/,
  "hook-error": /^(?:pre|post)$/,
};

/** Child clock values are bounded integers; a longer value is malformed, not clamped. */
const CHILD_MS = /^(0|[1-9]\d{0,6})$/;
const FRAME_NAME = /^[a-z][a-z-]{1,23}$/;
/** Longest possible frame line, including CRLF; every frame fits well inside the 4KiB stream bound. */
export const WINDOWS_LINEAGE_CAUSAL_MAX_FRAME_BYTES = 64;

export interface WindowsLineageCausalFrame {
  frame: WindowsLineageCausalChildFrame;
  childMs: number;
  token?: string;
}

function isChildFrame(value: string): value is WindowsLineageCausalChildFrame {
  return (WINDOWS_LINEAGE_CAUSAL_CHILD_FRAMES as readonly string[]).includes(value);
}

/**
 * One stderr line → a validated frame, `"malformed"` when the line carries the
 * frame prefix but not the exact grammar, or `undefined` for every other line
 * (host stderr is never interpreted or retained).
 */
export function parseWindowsLineageCausalFrame(line: string): WindowsLineageCausalFrame | "malformed" | undefined {
  const text = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!text.startsWith(WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX)) return undefined;
  if (Buffer.byteLength(text) + 2 > WINDOWS_LINEAGE_CAUSAL_MAX_FRAME_BYTES) return "malformed";
  const parts = text.slice(WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX.length).split(":");
  const [name, ms, token, ...extra] = parts;
  if (extra.length > 0 || name === undefined || !FRAME_NAME.test(name) || !isChildFrame(name)) return "malformed";
  if (ms === undefined || !CHILD_MS.test(ms)) return "malformed";
  const grammar = FRAME_TOKENS[name];
  if (grammar === undefined) {
    if (token !== undefined) return "malformed";
    return { frame: name, childMs: Number(ms) };
  }
  if (token === undefined || !grammar.test(token)) return "malformed";
  return { frame: name, childMs: Number(ms), token };
}

// ---------------------------------------------------------------------------
// Script instrumentation (passive hooks + child clock; production lines verbatim)
// ---------------------------------------------------------------------------

const STATE = "$global:PrgL446";
const CLOCK = `${STATE}.Clock.ElapsedMilliseconds`;
const OUT_FRAME = (name: WindowsLineageCausalChildFrame, tokenExpression?: string): string =>
  `[Console]::Error.WriteLine('${WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX}${name}:' + ${CLOCK}${
    tokenExpression === undefined ? "" : ` + ':' + ${tokenExpression}`})`;

/**
 * The prelude. Only assignments, `if`/`foreach`/`try`, comparisons, .NET static
 * and instance member access, and `[Console]` writes: no command of any kind is
 * invoked, so neither the prelude nor the delegates trigger command discovery. A
 * property read on a missing state object yields `$null` (no strict mode), so a
 * failed prelude can only produce malformed frames, never change a production
 * decision.
 */
function causalPrelude(gate: WindowsLineageCausalGateMode): string[] {
  const release = gate === "matched"
    ? [
      "          $prgToken = [Console]::In.ReadLine()",
      `          $prgAck = 'invalid'`,
      `          if ([string]::Equals($prgToken, '${WINDOWS_LINEAGE_CAUSAL_RELEASE_TOKEN}', [System.StringComparison]::Ordinal)) { $prgAck = 'ok' }`,
      `          ${OUT_FRAME("lookup-released", "$prgAck")}`,
    ]
    : [`          ${OUT_FRAME("lookup-released", "'ungated'")}`];
  return [
    `${STATE} = $null`,
    "try {",
    `  ${STATE} = @{ Clock = [System.Diagnostics.Stopwatch]::StartNew(); Pre = 0; Post = 0; Depth = 0; Outer = $false; Resolved = $false; Unpaired = $false; NestedSeen = $false; Native = (([string]$PSHOME).TrimEnd([char]92) + [char]92 + 'Modules') }`,
    `} catch { [Console]::Error.WriteLine('${WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX}prelude-error:0:state') }`,
    "try {",
    "  $prgModulePath = [string]$env:PSModulePath",
    "  $prgPs7 = -1",
    "  $prgNative = -1",
    "  $prgIndex = 0",
    "  foreach ($prgEntry in $prgModulePath.Split([char]59)) {",
    "    $prgTrimmed = $prgEntry.Trim().TrimEnd([char]92, [char]47)",
    "    if ($prgTrimmed.Length -gt 0) {",
    `      if (($prgNative -lt 0) -and [string]::Equals($prgTrimmed, ${STATE}.Native, [System.StringComparison]::OrdinalIgnoreCase)) { $prgNative = $prgIndex }`,
    "      $prgParts = $prgTrimmed.Split([char]92, [char]47)",
    "      $prgCount = $prgParts.Length",
    "      if (($prgPs7 -lt 0) -and ($prgCount -ge 3) -and [string]::Equals($prgParts[$prgCount - 1], 'Modules', [System.StringComparison]::OrdinalIgnoreCase)) {",
    "        $prgParent = $prgParts[$prgCount - 3]",
    "        $prgFolder = $prgParts[$prgCount - 2]",
    "        if ([string]::Equals($prgParent, 'PowerShell', [System.StringComparison]::OrdinalIgnoreCase) -and $prgFolder.StartsWith('7', [System.StringComparison]::Ordinal)) { $prgPs7 = $prgIndex }",
    "        elseif ([string]::Equals($prgFolder, 'PowerShell', [System.StringComparison]::OrdinalIgnoreCase) -and ([string]::Equals($prgParent, 'Documents', [System.StringComparison]::OrdinalIgnoreCase) -or [string]::Equals($prgParent, 'Program Files', [System.StringComparison]::OrdinalIgnoreCase))) { $prgPs7 = $prgIndex }",
    "      }",
    "      $prgIndex = $prgIndex + 1",
    "    }",
    "  }",
    "  $prgBits = '' + [int]($prgModulePath.Length -gt 0) + [int]($prgPs7 -ge 0) + [int]($prgNative -ge 0) + [int](($prgPs7 -ge 0) -and (($prgNative -lt 0) -or ($prgPs7 -lt $prgNative)))",
    `  ${OUT_FRAME("psmp", "$prgBits")}`,
    `} catch { ${OUT_FRAME("prelude-error", "'psmp'")} }`,
    "try {",
    "  $ExecutionContext.InvokeCommand.PreCommandLookupAction = {",
    "    param($prgName, $prgEvent)",
    "    try {",
    `      if ([string]::Equals([string]$prgName, '${WINDOWS_LINEAGE_CAUSAL_TARGET_COMMAND}', [System.StringComparison]::OrdinalIgnoreCase)) {`,
    `        $prgState = ${STATE}`,
    "        if ($prgState.Pre -lt 9) { $prgState.Pre = $prgState.Pre + 1 }",
    // Open target lookups are paired by depth, separately from the saturating counts;
    // a depth beyond the bound means pairing can no longer be established.
    "        if ($prgState.Depth -lt 9) { $prgState.Depth = $prgState.Depth + 1 }",
    `        elseif (-not $prgState.Unpaired) { $prgState.Unpaired = $true; ${OUT_FRAME("lookup-unpaired")} }`,
    "        if (-not $prgState.Outer) {",
    "          $prgState.Outer = $true",
    `          ${OUT_FRAME("lookup-ready")}`,
    ...release,
    "        }",
    "      }",
    `    } catch { ${OUT_FRAME("hook-error", "'pre'")} }`,
    "  }",
    "  $ExecutionContext.InvokeCommand.PostCommandLookupAction = {",
    "    param($prgName, $prgEvent)",
    "    try {",
    `      if ([string]::Equals([string]$prgName, '${WINDOWS_LINEAGE_CAUSAL_TARGET_COMMAND}', [System.StringComparison]::OrdinalIgnoreCase)) {`,
    `        $prgState = ${STATE}`,
    "        if ($prgState.Post -lt 9) { $prgState.Post = $prgState.Post + 1 }",
    // A post-lookup closes the innermost open target lookup. Only the one that
    // returns the depth to zero is the FIRST OUTER lookup completing; an earlier one
    // is a nested completion (e.g. a re-lookup during module autoload) and is
    // recorded as such, never as the outer resolution. A post-lookup with no open
    // lookup means pairing failed, which invalidates the instrument.
    "        if ($prgState.Depth -gt 0) { $prgState.Depth = $prgState.Depth - 1 }",
    `        elseif (-not $prgState.Unpaired) { $prgState.Unpaired = $true; ${OUT_FRAME("lookup-unpaired")} }`,
    "        if (($prgState.Depth -gt 0) -and (-not $prgState.Resolved) -and (-not $prgState.NestedSeen)) {",
    "          $prgState.NestedSeen = $true",
    `          ${OUT_FRAME("lookup-nested-post")}`,
    "        }",
    "        if (($prgState.Depth -eq 0) -and $prgState.Outer -and (-not $prgState.Unpaired) -and (-not $prgState.Resolved)) {",
    "          $prgState.Resolved = $true",
    "          $prgResolved = $prgEvent.Command",
    "          $prgClass = 'other'",
    "          if ($null -eq $prgResolved) { $prgClass = 'absent' }",
    "          elseif (($prgResolved -is [System.Management.Automation.CmdletInfo]) -and [string]::Equals([string]$prgResolved.ModuleName, 'CimCmdlets', [System.StringComparison]::OrdinalIgnoreCase)) {",
    "            $prgClass = 'cim-elsewhere'",
    "            $prgModule = $prgResolved.Module",
    "            if (($null -ne $prgModule) -and ([string]$prgModule.ModuleBase).StartsWith($prgState.Native + [char]92, [System.StringComparison]::OrdinalIgnoreCase)) { $prgClass = 'native-cim' }",
    "          }",
    `          ${OUT_FRAME("lookup-complete", "$prgClass")}`,
    "        }",
    "      }",
    `    } catch { ${OUT_FRAME("hook-error", "'post'")} }`,
    "  }",
    `  ${OUT_FRAME("hooks-installed")}`,
    `} catch { ${OUT_FRAME("prelude-error", "'hooks'")} }`,
  ];
}

interface CausalAnchor {
  prefix: string;
  before?: string[];
  after?: string[];
}

const CAUSAL_ANCHORS = (): CausalAnchor[] => [
  { prefix: "$ErrorActionPreference = 'Stop'" },
  {
    prefix: "$initial = @(Get-CimInstance",
    before: [OUT_FRAME("initial-query-start")],
    // Unparenthesized on purpose: the whole frame expression starts with a string
    // literal, so every `+` is string concatenation and can never throw (an int on
    // the left of `+ '-'` would be a conversion error under 'Stop').
    after: [OUT_FRAME("initial-query-end", `${STATE}.Pre + '-' + ${STATE}.Post + '-' + ${STATE}.Depth`)],
  },
  {
    prefix: "    $liveProcesses = @(Get-CimInstance",
    before: [`    ${OUT_FRAME("snapshot-start")}`],
    after: [`    ${OUT_FRAME("snapshot-end")}`],
  },
];

/** Bound on every added line, so the experiment can never grow the script without limit. */
export const WINDOWS_LINEAGE_CAUSAL_MAX_ADDED_LINES = 80;

export type WindowsLineageCausalScript =
  | { instrumented: true; script: string; addedLines: number; prelude: readonly string[] }
  | { instrumented: false; script: string; reason: "anchors-missing" | "line-limit" };

/**
 * Add the passive hook prelude and four child-clock frames to a production
 * lineage script. Every production line is copied verbatim and in order; only
 * whole lines are added (the prelude before the first production line). The
 * production script must start with its fixed first line and contain each anchor
 * exactly once, otherwise the ORIGINAL script is returned with a fixed reason.
 */
export function instrumentWindowsLineageCausalScript(
  script: string,
  gate: WindowsLineageCausalGateMode,
): WindowsLineageCausalScript {
  const lines = script.split("\n");
  const anchors = CAUSAL_ANCHORS();
  if (lines[0] !== anchors[0]!.prefix) return { instrumented: false, script, reason: "anchors-missing" };
  const before = new Map<number, string[]>();
  const after = new Map<number, string[]>();
  for (const anchor of anchors) {
    const matches = lines.map((line, index) => (line.startsWith(anchor.prefix) ? index : -1)).filter((index) => index >= 0);
    if (matches.length !== 1) return { instrumented: false, script, reason: "anchors-missing" };
    if (anchor.before) before.set(matches[0]!, anchor.before);
    if (anchor.after) after.set(matches[0]!, anchor.after);
  }
  const prelude = causalPrelude(gate);
  const output: string[] = [...prelude];
  lines.forEach((line, index) => {
    output.push(...(before.get(index) ?? []), line, ...(after.get(index) ?? []));
  });
  const addedLines = output.length - lines.length;
  if (addedLines > WINDOWS_LINEAGE_CAUSAL_MAX_ADDED_LINES) return { instrumented: false, script, reason: "line-limit" };
  return { instrumented: true, script: output.join("\n"), addedLines, prelude };
}

// ---------------------------------------------------------------------------
// Canonical frame ledger and instrument assessment
// ---------------------------------------------------------------------------

/** Parent-side observations, recorded in the same ledger as child frames. */
export const WINDOWS_LINEAGE_CAUSAL_PARENT_EVENTS = [
  "child-spawn",
  "stderr-first",
  "release-sent",
  "stdout-first",
  "child-exit",
  "child-close",
  "query-callback",
] as const;
export type WindowsLineageCausalParentEvent = (typeof WINDOWS_LINEAGE_CAUSAL_PARENT_EVENTS)[number];
export type WindowsLineageCausalEvent = WindowsLineageCausalChildFrame | WindowsLineageCausalParentEvent;

/** Canonical print order: creation, child setup, lookup, CIM, settlement, failures. */
export const WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER: readonly WindowsLineageCausalEvent[] = [
  "child-spawn", "stderr-first", "psmp", "hooks-installed", "initial-query-start", "lookup-ready",
  "release-sent", "lookup-released", "lookup-nested-post", "lookup-complete", "initial-query-end", "snapshot-start",
  "snapshot-end", "stdout-first", "child-exit", "child-close", "query-callback", "prelude-error", "hook-error",
  "lookup-unpaired",
];

export interface WindowsLineageCausalEventRecord {
  event: WindowsLineageCausalEvent;
  /** Whole milliseconds since this probe's query started, when THIS process noticed it. */
  parentMs: number;
  /** The child's own Stopwatch reading (child frames only). */
  childMs?: number;
  token?: string;
  count: number;
}

const MAX_EVENT_COUNT = 999;
const MAX_LINE_COUNT = 999;

/** The single bounded observation ledger of one query child. */
export interface WindowsLineageCausalLedger {
  readonly events: ReadonlyMap<WindowsLineageCausalEvent, WindowsLineageCausalEventRecord>;
  readonly malformed: number;
  readonly unrecognized: number;
  readonly duplicates: number;
  readonly scanTruncated: boolean;
  /** True once the actual child's close finalized the stream. */
  readonly finished: boolean;
}

export interface MutableCausalLedger extends WindowsLineageCausalLedger {
  record(event: WindowsLineageCausalEvent, parentMs: number, frame?: WindowsLineageCausalFrame): void;
  /** Feed raw stderr; only complete lines are parsed and no text is retained. */
  scan(chunk: string | Buffer, parentMs: number): void;
  /**
   * Finalize at the actual child's close. A remaining unterminated tail is never
   * parsed: every frame is written with a terminating newline, so a tail that is,
   * or begins like, an instrument frame is a truncated/malformed frame and fails the
   * instrument; any other tail is counted as unrecognized. The text is discarded and
   * later input is ignored.
   */
  finish(): void;
}

export function createWindowsLineageCausalLedger(): MutableCausalLedger {
  const events = new Map<WindowsLineageCausalEvent, WindowsLineageCausalEventRecord>();
  let malformed = 0;
  let unrecognized = 0;
  let duplicates = 0;
  let scanTruncated = false;
  let pending = "";
  let scanned = 0;
  let finished = false;
  const record = (event: WindowsLineageCausalEvent, parentMs: number, frame?: WindowsLineageCausalFrame): void => {
    const seen = events.get(event);
    if (seen !== undefined) {
      if (seen.count < MAX_EVENT_COUNT) seen.count += 1;
      // A child frame is written once by construction: a repeat is an instrument anomaly.
      if (frame !== undefined && duplicates < MAX_LINE_COUNT) duplicates += 1;
      return;
    }
    events.set(event, {
      event,
      parentMs,
      ...(frame === undefined ? {} : { childMs: frame.childMs }),
      ...(frame?.token === undefined ? {} : { token: frame.token }),
      count: 1,
    });
  };
  return {
    events,
    get malformed() { return malformed; },
    get unrecognized() { return unrecognized; },
    get duplicates() { return duplicates; },
    get scanTruncated() { return scanTruncated; },
    get finished() { return finished; },
    record,
    finish(): void {
      if (finished) return;
      finished = true;
      const tail = pending.replace(/\r$/, "");
      pending = "";
      if (scanTruncated || tail.trim().length === 0) return;
      const trimmed = tail.trimStart();
      const instrumentLike = tail.includes(WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX)
        || WINDOWS_LINEAGE_CAUSAL_FRAME_PREFIX.startsWith(trimmed);
      if (instrumentLike) {
        if (malformed < MAX_LINE_COUNT) malformed += 1;
      } else if (unrecognized < MAX_LINE_COUNT) {
        unrecognized += 1;
      }
    },
    scan(chunk: string | Buffer, parentMs: number): void {
      if (scanTruncated || finished) return;
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      scanned += Buffer.byteLength(text);
      // Never scan more than the child's own per-stream bound.
      if (scanned > MAX_QUERY_OUTPUT_BYTES) {
        scanTruncated = true;
        pending = "";
        return;
      }
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const parsed = parseWindowsLineageCausalFrame(line);
        if (parsed === "malformed") {
          if (malformed < MAX_LINE_COUNT) malformed += 1;
        } else if (parsed !== undefined) {
          record(parsed.frame, parentMs, parsed);
        } else if (line.trim().length > 0 && unrecognized < MAX_LINE_COUNT) {
          unrecognized += 1;
        }
      }
    },
  };
}

export const WINDOWS_LINEAGE_CAUSAL_INSTRUMENT_STATUSES = [
  "not-started",
  "extra-call",
  "unexpected-script",
  "anchors-missing",
  "line-limit",
  "scan-truncated",
  "frame-malformed",
  "frame-duplicate",
  "prelude-error",
  "hook-error",
  "hooks-unconfirmed",
  "hook-unobserved",
  "release-mismatch",
  "lookup-unpaired",
  "frame-order",
  "ok",
] as const;
export type WindowsLineageCausalInstrumentStatus = (typeof WINDOWS_LINEAGE_CAUSAL_INSTRUMENT_STATUSES)[number];

/** The ordered child chain the hooks must bracket for the initial request. */
const LOOKUP_CHAIN: readonly WindowsLineageCausalChildFrame[] = [
  "initial-query-start", "lookup-ready", "lookup-released", "lookup-complete", "initial-query-end",
];

/**
 * Judge whether the instrument itself behaved, from the ledger alone. This never
 * looks at the proof result: a slow or failed proof with a coherent ledger is an
 * observation, while missing, swallowed, malformed, duplicated, or out-of-order
 * hook data is an instrument failure — never read as a fast or slow lookup.
 * A child that reported the initial request starting but never reached its
 * pre-lookup frame is `hook-unobserved`: a stall there cannot be told apart from
 * an unsupported hook, so it is not claimed as either.
 */
export function assessWindowsLineageCausalLedger(
  ledger: WindowsLineageCausalLedger,
  gate: WindowsLineageCausalGateMode,
): WindowsLineageCausalInstrumentStatus {
  const events = ledger.events;
  const child = (frame: WindowsLineageCausalChildFrame): WindowsLineageCausalEventRecord | undefined => events.get(frame);
  if (ledger.scanTruncated) return "scan-truncated";
  if (ledger.malformed > 0) return "frame-malformed";
  if (ledger.duplicates > 0) return "frame-duplicate";
  if (child("prelude-error")) return "prelude-error";
  if (child("hook-error")) return "hook-error";
  if (child("lookup-unpaired")) return "lookup-unpaired";
  const psmp = child("psmp");
  const installed = child("hooks-installed");
  if (!psmp || !installed) return "hooks-unconfirmed";
  // Pairing evidence from the child's own counters at the end of the initial
  // request: no target lookup may still be open, and (below saturation) every
  // pre-lookup must have had its post-lookup. A completion that cannot be paired
  // with the first outer lookup is never accepted as that lookup's resolution.
  const end = child("initial-query-end");
  if (end) {
    const [pre, post, open] = (end.token ?? "0-0-0").split("-").map(Number) as [number, number, number];
    if (open !== 0) return "lookup-unpaired";
    if (pre < 9 && post < 9 && pre - post !== open) return "lookup-unpaired";
    if (!(pre >= 1 && post >= 1)) return "frame-order";
  }
  const observed = LOOKUP_CHAIN.map((frame) => child(frame));
  const reached = observed.findIndex((record) => record === undefined);
  const prefixLength = reached < 0 ? observed.length : reached;
  if (observed.slice(prefixLength).some((record) => record !== undefined)) return "hook-unobserved";
  if (prefixLength === 1) return "hook-unobserved";
  const released = child("lookup-released");
  if (released) {
    const expected = gate === "matched" ? ["ok", "invalid"] : ["ungated"];
    if (!expected.includes(released.token ?? "")) return "release-mismatch";
  }
  const ordered: number[] = [psmp.childMs ?? -1, installed.childMs ?? -1];
  for (const record of observed.slice(0, prefixLength)) ordered.push(record!.childMs ?? -1);
  const snapshotStart = child("snapshot-start");
  const snapshotEnd = child("snapshot-end");
  if ((snapshotStart || snapshotEnd) && prefixLength < LOOKUP_CHAIN.length) return "frame-order";
  if (snapshotEnd && !snapshotStart) return "frame-order";
  if (snapshotStart) ordered.push(snapshotStart.childMs ?? -1);
  if (snapshotEnd) ordered.push(snapshotEnd.childMs ?? -1);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! < ordered[index - 1]!) return "frame-order";
  }
  // A nested completion can only happen after the outer lookup was released and
  // before the outer lookup completed.
  const nested = child("lookup-nested-post");
  if (nested) {
    const complete = child("lookup-complete");
    if (!released || (nested.childMs ?? -1) < (released.childMs ?? 0)) return "frame-order";
    if (complete && (complete.childMs ?? -1) < (nested.childMs ?? 0)) return "frame-order";
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

export type WindowsLineageGateStatus = "pending" | "released" | "invalid";
export const WINDOWS_LINEAGE_GATE_INVALID_REASONS = [
  "bound-expired",
  "party-closed-before-release",
  "duplicate-party",
  "unknown-party",
  "disposed-pending",
] as const;
export type WindowsLineageGateInvalidReason = (typeof WINDOWS_LINEAGE_GATE_INVALID_REASONS)[number];

export interface WindowsLineageReleaseGateRecord {
  status: WindowsLineageGateStatus;
  reason?: WindowsLineageGateInvalidReason;
  parties: number;
  registered: number;
  ready: number;
  boundMs: number;
  /** Parent ms from the first ready report to the release (released gates only). */
  waitMs?: number;
}

export interface WindowsLineageReleaseGate {
  /** A party's query child exists; `release(true)` writes the token then ends stdin, `release(false)` only ends it. */
  register(arm: WindowsLineageCausalArm, release: (withToken: boolean) => void): void;
  ready(arm: WindowsLineageCausalArm): void;
  /** The party's query child closed; before release that invalidates the gate. */
  closed(arm: WindowsLineageCausalArm): void;
  /** Cancel the bound and end every party's stdin. Idempotent; a pending gate becomes invalid. */
  dispose(): void;
  record(): WindowsLineageReleaseGateRecord;
}

export interface WindowsLineageReleaseGateOptions {
  parties: readonly WindowsLineageCausalArm[];
  boundMs?: number;
  now?: () => number;
  /** Test seam for the bound timer. */
  schedule?: (callback: () => void, ms: number) => { cancel(): void };
}

/**
 * Release every registered party's query child only once ALL parties reported
 * their first outer target pre-lookup. It never launches, retries, or signals a
 * process: its only actions are ending stdin, with or without the token. Every
 * failure releases all parties WITHOUT the token, so a waiting child proceeds
 * (its acknowledgement then reads `invalid`) inside the unchanged query deadline.
 */
export function createWindowsLineageReleaseGate(options: WindowsLineageReleaseGateOptions): WindowsLineageReleaseGate {
  const expected = new Set(options.parties);
  const boundMs = options.boundMs ?? WINDOWS_LINEAGE_CAUSAL_GATE_BOUND_MS;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms);
    return { cancel: () => clearTimeout(timer) };
  });
  const releases = new Map<WindowsLineageCausalArm, (withToken: boolean) => void>();
  const readySet = new Set<WindowsLineageCausalArm>();
  let status: WindowsLineageGateStatus = "pending";
  let reason: WindowsLineageGateInvalidReason | undefined;
  let firstReadyAt: number | undefined;
  let waitMs: number | undefined;
  let bound: { cancel(): void } | undefined;

  const releaseAll = (withToken: boolean): void => {
    for (const release of releases.values()) {
      try {
        release(withToken);
      } catch {
        // A failed stdin end is recorded by the party itself; the gate keeps going.
      }
    }
  };
  const invalidate = (why: WindowsLineageGateInvalidReason): void => {
    if (status !== "pending") return;
    status = "invalid";
    reason = why;
    bound?.cancel();
    bound = undefined;
    releaseAll(false);
  };
  return {
    register(arm, release): void {
      if (!expected.has(arm)) {
        try { release(false); } catch { /* recorded by the party */ }
        invalidate("unknown-party");
        return;
      }
      if (releases.has(arm)) {
        try { release(false); } catch { /* recorded by the party */ }
        invalidate("duplicate-party");
        return;
      }
      releases.set(arm, release);
      if (status !== "pending") {
        try { release(false); } catch { /* recorded by the party */ }
      }
    },
    ready(arm): void {
      if (status !== "pending" || !releases.has(arm) || readySet.has(arm)) return;
      readySet.add(arm);
      if (firstReadyAt === undefined) {
        firstReadyAt = now();
        bound = schedule(() => invalidate("bound-expired"), boundMs);
      }
      if (readySet.size === expected.size) {
        status = "released";
        bound?.cancel();
        bound = undefined;
        waitMs = Math.max(0, Math.round(now() - firstReadyAt));
        releaseAll(true);
      }
    },
    closed(arm): void {
      if (status === "pending" && releases.has(arm)) invalidate("party-closed-before-release");
    },
    dispose(): void {
      // A pending gate fails and ends every registered stdin without the token; a
      // released or already-invalid gate already ended each one, so nothing is resent.
      invalidate("disposed-pending");
      bound?.cancel();
      bound = undefined;
    },
    record: () => ({
      status,
      ...(reason === undefined ? {} : { reason }),
      parties: expected.size,
      registered: releases.size,
      ready: readySet.size,
      boundMs,
      ...(waitMs === undefined ? {} : { waitMs }),
    }),
  };
}

export function formatWindowsLineageReleaseGate(record: WindowsLineageReleaseGateRecord): string {
  const status = (["pending", "released", "invalid"] as const).includes(record.status) ? record.status : "?";
  const reason = record.reason !== undefined && (WINDOWS_LINEAGE_GATE_INVALID_REASONS as readonly string[]).includes(record.reason)
    ? record.reason
    : "none";
  return [
    "prg-l446-gate",
    `v=${WINDOWS_LINEAGE_CAUSAL_VERSION}`,
    `experiment=${WINDOWS_LINEAGE_CAUSAL_EXPERIMENT}`,
    `status=${status}`,
    `reason=${reason}`,
    `parties=${boundedInteger(record.parties)}`,
    `registered=${boundedInteger(record.registered)}`,
    `ready=${boundedInteger(record.ready)}`,
    `boundMs=${boundedInteger(record.boundMs)}`,
    `waitMs=${record.waitMs === undefined ? "none" : boundedInteger(record.waitMs)}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// Per-query probe
// ---------------------------------------------------------------------------

/** The real query child as the probe observes it: the production child surface plus stdin and lifecycle. */
export interface WindowsLineageCausalChild extends WindowsLineageQueryChild {
  readonly stdin?: {
    end(chunk?: string): unknown;
    on(event: "error", listener: (error: Error) => void): unknown;
  } | null;
  once(event: "spawn" | "exit" | "close", listener: () => void): unknown;
}

/** Exactly the production query options; the legacy control only replaces `env`. */
export type WindowsLineageCausalLaunchOptions = WindowsLineageQueryOptions;

export type WindowsLineageCausalLauncher = (
  file: string,
  args: string[],
  options: WindowsLineageCausalLaunchOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => WindowsLineageCausalChild;

const nativeLauncher: WindowsLineageCausalLauncher = (file, args, options, callback) =>
  execFile(file, args, options, callback);

export interface WindowsLineageCausalProbeOptions {
  arm: WindowsLineageCausalArm;
  role: WindowsLineageCausalRole;
  gate: WindowsLineageCausalGateMode;
  /** Required for `matched`; ignored for `ungated`. */
  releaseGate?: WindowsLineageReleaseGate;
  /**
   * The original parent environment: classified for `parentPsmp`, and the legacy
   * control's override. Default: `process.env`. The corrected arm never uses it.
   */
  parentEnv?: NodeJS.ProcessEnv;
  /** Default: execFile, as production launches the query child. */
  launch?: WindowsLineageCausalLauncher;
  now?: () => number;
}

export interface WindowsLineageCausalRecord {
  arm: WindowsLineageCausalArm;
  role: WindowsLineageCausalRole;
  gate: WindowsLineageCausalGateMode;
  treatment: WindowsLineageCausalTreatment;
  result: WindowsLineageVerification;
  elapsedMs: number;
  calls: number;
  callbacks: number;
  instrument: WindowsLineageCausalInstrumentStatus;
  exitWitnessed: boolean;
  closeWitnessed: boolean;
  stdinFailed: boolean;
  parentModulePath: string;
  /** The producer handed this probe an environment object distinct from `parentEnv`. */
  producerEnv: boolean;
  /** Closed categories of the environment actually launched (`0000`: no `PSModulePath`). */
  launchModulePath: string;
  /** Case-insensitive `PSModulePath` keys in the environment actually launched (saturating). */
  launchModulePathKeys: number;
  childModulePath: string;
  lookupClass: string;
  lookupCounts: string;
  releaseAck: string;
  /** Parent ms from this child's ready report to the release write (gated only). */
  gateWaitMs?: number;
  malformed: number;
  unrecognized: number;
  duplicates: number;
  scanTruncated: boolean;
  events: readonly WindowsLineageCausalEventRecord[];
}

export interface WindowsLineageCausalProbe {
  /** Pass as the existing `WindowsLineageQueryProbe.execute` seam. */
  readonly execute: WindowsLineageQueryExecutor;
  /** Resolves `true` on the actual query child's `close`, `false` at once when no child was started. */
  whenClosed(): Promise<boolean>;
  record(result: WindowsLineageVerification): WindowsLineageCausalRecord;
  summary(result: WindowsLineageVerification): string;
  /** End a still-open gated stdin without the token. Idempotent; launches nothing. */
  dispose(): void;
}

/**
 * Wrap the real query launch with the causal treatment and passive observation.
 *
 * Exactly one query child per probe: a second `execute` throws synchronously
 * (production maps that to its fixed spawn stage) and starts nothing. The
 * production executable and the four leading arguments are passed through; the
 * script argument is the instrumented copy (or the untouched original when
 * instrumentation fails closed). The corrected `child-scoped` arm forwards the
 * producer's options object verbatim, environment included; only the legacy
 * `inherited` control replaces its `env` with the original parent environment.
 * The completion callback is forwarded verbatim; everything else is a listener.
 */
export function createWindowsLineageCausalProbe(options: WindowsLineageCausalProbeOptions): WindowsLineageCausalProbe {
  const { arm, role, gate } = options;
  const launch = options.launch ?? nativeLauncher;
  const now = options.now ?? (() => performance.now());
  const parentEnv = options.parentEnv ?? process.env;
  const treatment = TREATMENT_BY_ARM[arm];
  const ledger = createWindowsLineageCausalLedger();
  let startedAt = 0;
  let calls = 0;
  let scriptStatus: WindowsLineageCausalInstrumentStatus | undefined;
  let parentModulePath = "?";
  let producerEnv = false;
  let launchModulePath = "?";
  let launchModulePathKeys = 0;
  let stdinFailed = false;
  let stdinEnded = false;
  let child: WindowsLineageCausalChild | undefined;
  let resolveClosed: ((closed: boolean) => void) | undefined;
  const closed = new Promise<boolean>((resolvePromise) => { resolveClosed = resolvePromise; });

  const elapsed = (): number => (calls > 0 ? Math.max(0, Math.round(now() - startedAt)) : 0);
  const endStdin = (withToken: boolean): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    try {
      const stdin = child?.stdin;
      if (!stdin) {
        stdinFailed = true;
        return;
      }
      if (withToken) {
        stdin.end(`${WINDOWS_LINEAGE_CAUSAL_RELEASE_TOKEN}\n`);
        ledger.record("release-sent", elapsed(), undefined);
      } else {
        stdin.end();
      }
    } catch {
      stdinFailed = true;
    }
  };

  const execute: WindowsLineageQueryExecutor = (file, args, queryOptions, callback) => {
    if (calls > 0) {
      calls += 1;
      throw new Error("the causal probe owns exactly one query child");
    }
    calls = 1;
    startedAt = now();
    const nativeModules = nativeWindowsModulesDir(parentEnv.SystemRoot ?? parentEnv.WINDIR);
    parentModulePath = classifyModulePathCategories(modulePathValue(parentEnv), nativeModules);
    const script = typeof args[4] === "string" ? args[4] : undefined;
    const outcome = script === undefined ? undefined : instrumentWindowsLineageCausalScript(script, gate);
    scriptStatus = outcome === undefined ? "unexpected-script" : outcome.instrumented ? undefined : outcome.reason;
    const launchArgs = outcome?.instrumented === true ? args.map((arg, index) => (index === 4 ? outcome.script : arg)) : args;
    const supplied = (queryOptions as { env?: unknown }).env;
    producerEnv = typeof supplied === "object" && supplied !== null && supplied !== parentEnv;
    // The legacy control is an explicit override back to the original parent
    // environment; the corrected arm launches exactly what the producer built.
    const launchOptions: WindowsLineageCausalLaunchOptions = treatment === "legacy-inherited-override"
      ? { ...queryOptions, env: parentEnv }
      : queryOptions;
    // An options object without `env` makes the child inherit this process's environment.
    const launchedEnv = launchOptions.env ?? process.env;
    launchModulePath = classifyModulePathCategories(modulePathValue(launchedEnv), nativeModules);
    launchModulePathKeys = countModulePathKeys(launchedEnv);
    let launched: WindowsLineageCausalChild;
    try {
      launched = launch(file, launchArgs, launchOptions, (error, stdout, stderr) => {
        ledger.record("query-callback", elapsed());
        callback(error, stdout, stderr);
      });
    } catch (error) {
      resolveClosed?.(false);
      throw error;
    }
    child = launched;
    launched.stdin?.on("error", () => { stdinFailed = true; });
    launched.stdout?.on("data", () => {
      if (!ledger.events.has("stdout-first")) ledger.record("stdout-first", elapsed());
    });
    launched.stderr?.on("data", (chunk: string | Buffer) => {
      const at = elapsed();
      if (!ledger.events.has("stderr-first")) ledger.record("stderr-first", at);
      const readyBefore = ledger.events.has("lookup-ready");
      ledger.scan(chunk, at);
      if (!readyBefore && ledger.events.has("lookup-ready") && gate === "matched") options.releaseGate?.ready(arm);
    });
    launched.once("spawn", () => ledger.record("child-spawn", elapsed()));
    launched.once("exit", () => ledger.record("child-exit", elapsed()));
    launched.once("close", () => {
      ledger.record("child-close", elapsed());
      // Only a gated child's stdin is ever ended; an ungated child's stdin is left
      // exactly as production leaves it.
      // Every stdio stream has ended before `close`, so the ledger is finalized here,
      // before anyone awaiting the close can read a record.
      ledger.finish();
      if (gate === "matched") {
        options.releaseGate?.closed(arm);
        endStdin(false);
      }
      resolveClosed?.(true);
    });
    if (gate === "matched") {
      if (options.releaseGate) options.releaseGate.register(arm, endStdin);
      else endStdin(false);
    }
    return launched;
  };

  const record = (result: WindowsLineageVerification): WindowsLineageCausalRecord => {
    const events = WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER
      .filter((event) => ledger.events.has(event))
      .map((event) => ({ ...ledger.events.get(event)! }));
    const ready = ledger.events.get("lookup-ready");
    const sent = ledger.events.get("release-sent");
    let instrument: WindowsLineageCausalInstrumentStatus;
    if (calls === 0) instrument = "not-started";
    else if (calls > 1) instrument = "extra-call";
    else if (scriptStatus !== undefined) instrument = scriptStatus;
    else instrument = assessWindowsLineageCausalLedger(ledger, gate);
    return {
      arm,
      role,
      gate,
      treatment,
      result,
      elapsedMs: elapsed(),
      calls,
      callbacks: ledger.events.get("query-callback")?.count ?? 0,
      instrument,
      exitWitnessed: ledger.events.has("child-exit"),
      closeWitnessed: ledger.events.has("child-close"),
      stdinFailed,
      parentModulePath,
      producerEnv,
      launchModulePath,
      launchModulePathKeys,
      childModulePath: ledger.events.get("psmp")?.token ?? "?",
      lookupClass: ledger.events.get("lookup-complete")?.token ?? "none",
      lookupCounts: ledger.events.get("initial-query-end")?.token ?? "none",
      releaseAck: ledger.events.get("lookup-released")?.token ?? "none",
      ...(ready !== undefined && sent !== undefined ? { gateWaitMs: Math.max(0, sent.parentMs - ready.parentMs) } : {}),
      malformed: ledger.malformed,
      unrecognized: ledger.unrecognized,
      duplicates: ledger.duplicates,
      scanTruncated: ledger.scanTruncated,
      events,
    };
  };

  return {
    execute,
    whenClosed: () => (calls === 0 ? Promise.resolve(false) : closed),
    record,
    summary: (result) => formatWindowsLineageCausalRecord(record(result)),
    dispose: () => {
      if (gate === "matched" && child !== undefined) endStdin(false);
    },
  };
}

// ---------------------------------------------------------------------------
// Bounded rendering and experiment validity
// ---------------------------------------------------------------------------

function boundedInteger(value: number): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2 ** 31 - 1
    ? String(value)
    : "?";
}

function oneOf(value: unknown, allowed: readonly string[], fallback = "?"): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function resultToken(result: WindowsLineageVerification): string {
  if (result?.verified === true) return "verified";
  return isWindowsLineageRefusalReason((result as { reason?: unknown } | undefined)?.reason)
    ? (result as { reason: string }).reason
    : "unknown";
}

const COUNTS_TOKEN = /^[0-9]-[0-9]-[0-9]$/;

/**
 * The single bounded summary line of one query. Every field is re-validated
 * against its closed vocabulary or integer bound here, so no caller-supplied
 * free text can reach the output; trailing events are withheld (and counted) to
 * respect the cap.
 */
export function formatWindowsLineageCausalRecord(record: WindowsLineageCausalRecord): string {
  const head = [
    "prg-l446",
    `v=${WINDOWS_LINEAGE_CAUSAL_VERSION}`,
    `experiment=${WINDOWS_LINEAGE_CAUSAL_EXPERIMENT}`,
    `arm=${oneOf(record.arm, WINDOWS_LINEAGE_CAUSAL_ARMS)}`,
    `role=${oneOf(record.role, WINDOWS_LINEAGE_CAUSAL_ROLES)}`,
    `treatment=${oneOf(record.treatment, WINDOWS_LINEAGE_CAUSAL_TREATMENTS)}`,
    `gate=${oneOf(record.gate, ["matched", "ungated"])}`,
    `result=${resultToken(record.result)}`,
    `instrument=${oneOf(record.instrument, WINDOWS_LINEAGE_CAUSAL_INSTRUMENT_STATUSES)}`,
    `calls=${boundedInteger(record.calls)}`,
    `callbacks=${boundedInteger(record.callbacks)}`,
    `exit=${record.exitWitnessed === true}`,
    `close=${record.closeWitnessed === true}`,
    `stdinFailed=${record.stdinFailed === true}`,
    `parentPsmp=${MODULE_PATH_BITS.test(String(record.parentModulePath)) ? record.parentModulePath : "?"}`,
    `producerEnv=${record.producerEnv === true}`,
    `launchPsmp=${MODULE_PATH_BITS.test(String(record.launchModulePath)) ? record.launchModulePath : "?"}`,
    `launchPsmpKeys=${boundedInteger(record.launchModulePathKeys)}`,
    `childPsmp=${MODULE_PATH_BITS.test(String(record.childModulePath)) ? record.childModulePath : "?"}`,
    `lookup=${oneOf(record.lookupClass, [...WINDOWS_LINEAGE_CAUSAL_LOOKUP_CLASSES, "none"])}`,
    `lookups=${record.lookupCounts === "none" || COUNTS_TOKEN.test(String(record.lookupCounts)) ? record.lookupCounts : "?"}`,
    `ack=${oneOf(record.releaseAck, [...WINDOWS_LINEAGE_CAUSAL_RELEASE_ACKS, "none"])}`,
    `gateWaitMs=${record.gateWaitMs === undefined ? "none" : boundedInteger(record.gateWaitMs)}`,
    `malformed=${boundedInteger(record.malformed)}`,
    `unrecognized=${boundedInteger(record.unrecognized)}`,
    `duplicates=${boundedInteger(record.duplicates)}`,
    `scanTruncated=${record.scanTruncated === true}`,
    `elapsedMs=${boundedInteger(record.elapsedMs)}`,
  ].join(" ");
  const seen = new Set<WindowsLineageCausalEvent>();
  const entries: string[] = [];
  const byEvent = new Map<WindowsLineageCausalEvent, WindowsLineageCausalEventRecord>();
  for (const event of record.events ?? []) {
    if (!WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER.includes(event.event) || byEvent.has(event.event)) continue;
    byEvent.set(event.event, event);
  }
  for (const name of WINDOWS_LINEAGE_CAUSAL_EVENT_ORDER) {
    const event = byEvent.get(name);
    if (event === undefined || seen.has(name)) continue;
    seen.add(name);
    const childPart = isChildFrame(name) && event.childMs !== undefined ? `/c${boundedInteger(event.childMs)}` : "";
    const grammar = isChildFrame(name) ? FRAME_TOKENS[name] : undefined;
    const tokenPart = grammar !== undefined && typeof event.token === "string" && grammar.test(event.token) ? `:${event.token}` : "";
    const count = event.count > 1 ? `x${boundedInteger(event.count)}` : "";
    entries.push(`${name}@${boundedInteger(event.parentMs)}${childPart}${count}${tokenPart}`);
  }
  for (let keep = entries.length; keep > 0; keep -= 1) {
    const withheld = entries.length - keep;
    const shown = withheld > 0 ? [...entries.slice(0, keep), `+${withheld}`] : entries;
    const text = `${head} events=[${shown.join(",")}]`;
    if (text.length <= WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS) return text;
  }
  return `${head} events=[${entries.length > 0 ? `+${entries.length}` : ""}]`.slice(0, WINDOWS_LINEAGE_CAUSAL_SUMMARY_MAX_CHARS);
}

export type WindowsLineageCausalValidity = { valid: true } | { valid: false; reasons: string[] };

/**
 * Whether the fixed experiment ran as designed. Validity is about the
 * EXPERIMENT (gate, instrument, one child per verification, witnessed closure),
 * never about which proofs passed: a valid experiment with a failed proof is the
 * observation the experiment exists for, and an invalid one is never evidence of
 * the historical timeout. Reasons are fixed tokens built only from closed values.
 */
export function assessWindowsLineageCausalExperiment(input: {
  gate: WindowsLineageReleaseGateRecord;
  records: readonly WindowsLineageCausalRecord[];
}): WindowsLineageCausalValidity {
  const reasons: string[] = [];
  const { gate, records } = input;
  if (gate.status !== "released") reasons.push(`gate-${oneOf(gate.status, ["pending", "invalid"])}-${oneOf(gate.reason, WINDOWS_LINEAGE_GATE_INVALID_REASONS, "none")}`);
  else if (gate.waitMs === undefined || gate.waitMs > gate.boundMs) reasons.push("gate-wait-unbounded");
  for (const arm of WINDOWS_LINEAGE_CAUSAL_ARMS) {
    for (const role of WINDOWS_LINEAGE_CAUSAL_ROLES) {
      const matching = records.filter((record) => record.arm === arm && record.role === role);
      const id = `${arm}-${role}`;
      if (matching.length !== 1) {
        reasons.push(`${id}-records-${matching.length === 0 ? "missing" : "duplicated"}`);
        continue;
      }
      const record = matching[0]!;
      if (record.treatment !== TREATMENT_BY_ARM[arm]) reasons.push(`${id}-treatment-mismatch`);
      // Both arms must have received the producer's own environment; the corrected
      // arm must have launched it without any PSModulePath key. The legacy control
      // is checked only for having been an override, never for what it inherited.
      if (record.producerEnv !== true) reasons.push(`${id}-producer-env-missing`);
      if (arm === "child-scoped" && record.launchModulePathKeys !== 0) reasons.push(`${id}-launch-env-module-path`);
      const expectedGate: WindowsLineageCausalGateMode = role === "positive" ? "matched" : "ungated";
      if (record.gate !== expectedGate) reasons.push(`${id}-gate-mode-mismatch`);
      if (record.calls !== 1) reasons.push(`${id}-calls-not-one`);
      if (record.callbacks !== 1) reasons.push(`${id}-callback-not-one`);
      if (!record.exitWitnessed) reasons.push(`${id}-exit-unwitnessed`);
      if (!record.closeWitnessed) reasons.push(`${id}-close-unwitnessed`);
      if (record.stdinFailed) reasons.push(`${id}-stdin-failed`);
      if (record.instrument !== "ok") reasons.push(`${id}-instrument-${oneOf(record.instrument, WINDOWS_LINEAGE_CAUSAL_INSTRUMENT_STATUSES)}`);
      // A gated positive must have acknowledged the exact token the gate wrote; an
      // ungated negative must never report a gate acknowledgement.
      const ackOk = role === "positive"
        ? record.releaseAck === "ok"
        : record.releaseAck === "ungated" || record.releaseAck === "none";
      if (!ackOk) reasons.push(`${id}-ack-${oneOf(record.releaseAck, [...WINDOWS_LINEAGE_CAUSAL_RELEASE_ACKS, "none"])}`);
    }
  }
  return reasons.length === 0 ? { valid: true } : { valid: false, reasons };
}
