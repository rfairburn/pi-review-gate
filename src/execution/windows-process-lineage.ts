import { execFile, type ChildProcess, type ExecFileException } from "node:child_process";
import { isAbsolute, join } from "node:path";

const LINEAGE_QUERY_TIMEOUT_MS = 5_000;
const MAX_ANCESTOR_STEPS = 64;
/** Exported so diagnostics tests state the bound the child itself enforces. */
export const MAX_QUERY_OUTPUT_BYTES = 4 * 1024;
/** Exported so the native fixture validates one shared usable-PID bound. */
export const MAX_WINDOWS_PROCESS_ID = 0xffff_ffff;
const MAX_DATE_TIME_TICKS = "3155378975999999999";
const LINEAGE_FAILURE = "PI_REVIEW_GATE_LINEAGE_NO";
const LINEAGE_FAILURE_PREFIX = `${LINEAGE_FAILURE}:`;

/**
 * Fixed, sanitized refusal stages for one lineage verification. Every value is
 * a stable literal from this list: no query output, host path, PID, command
 * line, error text, or process inventory is ever reported. A stage only says
 * WHICH bounded check refused; it never changes what acceptance requires, and
 * an unknown or malformed diagnostic value can never turn into acceptance.
 */
export const WINDOWS_LINEAGE_REFUSAL_REASONS = [
  "preflight-not-win32",
  "preflight-identity-invalid",
  "preflight-owned-root-exited",
  "preflight-host-root-invalid",
  "query-spawn-failed",
  "query-nonzero-exit",
  "query-timeout",
  "query-output-cap",
  "query-failed",
  "chain-candidate-record-missing",
  "chain-ancestor-record-missing",
  "chain-parent-absent",
  "chain-cycle",
  "chain-depth-limit",
  "chain-owned-root-record-missing",
  "snapshot-count-mismatch",
  "snapshot-record-missing",
  "snapshot-creation-mismatch",
  "snapshot-parent-incoherent",
  "sentinel-unrecognized",
  "evidence-identity-invalid",
  "evidence-bound-violation",
  "evidence-shape-invalid",
  "evidence-candidate-mismatch",
  "evidence-owned-root-mismatch",
  "evidence-duplicate-pid",
  "evidence-chain-broken",
  "evidence-creation-order-invalid",
  "evidence-snapshot-unstable",
  "owned-root-exited-after-query",
] as const;

export type WindowsLineageRefusalReason = (typeof WINDOWS_LINEAGE_REFUSAL_REASONS)[number];

/** The only stages the native script's own sentinel is allowed to report. */
export const WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS = [
  "chain-candidate-record-missing",
  "chain-ancestor-record-missing",
  "chain-parent-absent",
  "chain-cycle",
  "chain-depth-limit",
  "chain-owned-root-record-missing",
  "snapshot-count-mismatch",
  "snapshot-record-missing",
  "snapshot-creation-mismatch",
  "snapshot-parent-incoherent",
] as const satisfies readonly WindowsLineageRefusalReason[];

export type WindowsLineageVerification =
  | { verified: true }
  | { verified: false; reason: WindowsLineageRefusalReason };

/** True only for a stage literal from the fixed list above. */
export function isWindowsLineageRefusalReason(value: unknown): value is WindowsLineageRefusalReason {
  return typeof value === "string"
    && (WINDOWS_LINEAGE_REFUSAL_REASONS as readonly string[]).includes(value);
}

function isWindowsLineageNativeSentinelReason(value: string): value is WindowsLineageRefusalReason {
  return (WINDOWS_LINEAGE_NATIVE_SENTINEL_REASONS as readonly string[]).includes(value);
}

function refusal(reason: WindowsLineageRefusalReason): WindowsLineageVerification {
  return { verified: false, reason };
}

/** The one bounded query child this module drives (production: execFile's). */
export type WindowsLineageQueryChild = Pick<ChildProcess, "kill" | "stdout" | "stderr">;

export interface WindowsLineageQueryOptions {
  encoding: "utf8";
  maxBuffer: number;
  windowsHide: boolean;
}

export type WindowsLineageQueryExecutor = (
  file: string,
  args: string[],
  options: WindowsLineageQueryOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => WindowsLineageQueryChild;

/**
 * Positive evidence witnessed by this module's OWN deadline callback and output
 * accounting. `timedOut` is set only when the owned timer callback fires, so a
 * timeout is never inferred from `err.killed`, `err.signal`, or elapsed time.
 * Stream bounds are counted per stream because that is how the child's
 * `maxBuffer` bound applies: neither stream overflowing is not an output cap.
 */
export interface WindowsLineageQueryWitness {
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * Optional seams used by the focused cross-platform regressions. They change
 * nothing about acceptance: the same bounded query, the same native sentinel,
 * and the same evidence validation run either way, and production callers pass
 * nothing here.
 */
export interface WindowsLineageQueryProbe {
  /** Test seam: drive the win32 orchestration off-Windows. */
  platform?: NodeJS.Platform;
  /** Test seam: substitute the bounded query child (production: `execFile`). */
  execute?: WindowsLineageQueryExecutor;
}

const productionQueryExecutor: WindowsLineageQueryExecutor = (file, args, options, callback) =>
  execFile(file, args, options, callback);

/**
 * Verify that `candidatePid` is a live strict descendant of an owned Windows
 * child process, and report a fixed sanitized stage when it is not. The child
 * PID remains the cleanup root; this bounded CIM ancestry check identifies the
 * Pi Node process behind a cmd.exe/npm shim without inspecting command lines,
 * paths, or shim contents.
 *
 * Any unavailable, malformed, timed-out, or oversized system response fails
 * closed. PowerShell receives only validated positive integer PIDs embedded as
 * decimal literals and walks at most 64 parent links. Its bounded output
 * contains only process IDs and creation-time ticks; the local validator checks
 * snapshot stability and rejects a parent created after its child, preventing a
 * recycled ancestor PID from satisfying proof. Exactly one bounded query child
 * runs per verification: no retry, cache, or polling.
 *
 * The two PIDs this verification already knows before querying anything — the
 * candidate and the owned root — are observed in the script's single initial
 * request, which saves one CIM round trip per proof. That response is accepted as
 * usable evidence only when its membership is exactly one candidate row, at most
 * one owned-root row, and no row for any other PID; a duplicated, ambiguous, or
 * unexpected row refuses on an existing fixed stage instead of silently selecting
 * one of the conflicting rows. The initial root record is only a candidate
 * observation for this verification: it is appended to the chain only after the
 * parent walk actually reaches the root, and the fresh full-chain snapshot still
 * re-reads every chain member and re-validates its creation identity, so an earlier
 * observation can never substitute for the ancestry walk or for the independent
 * liveness check.
 */
export async function verifyWindowsProcessLineage(
  ownedRoot: ChildProcess,
  candidatePid: number,
  probe: WindowsLineageQueryProbe = {},
): Promise<WindowsLineageVerification> {
  const platform = probe.platform ?? process.platform;
  const rootPid = ownedRoot.pid;
  if (platform !== "win32") return refusal("preflight-not-win32");
  if (!isPositivePid(rootPid) || !isPositivePid(candidatePid) || rootPid === candidatePid) {
    return refusal("preflight-identity-invalid");
  }
  if (ownedRoot.exitCode !== null || ownedRoot.signalCode !== null) return refusal("preflight-owned-root-exited");

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) return refusal("preflight-host-root-invalid");
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  const query = await runBoundedLineageQuery(
    powershell,
    buildLineageScript(candidatePid, rootPid),
    probe.execute ?? productionQueryExecutor,
  );
  if (!query.ok) return refusal(query.reason);

  const evidence = classifyWindowsAncestryEvidence(query.output, candidatePid, rootPid);
  if (!evidence.verified) return evidence;
  // The owned command root must still be live at the moment of binding.
  if (ownedRoot.exitCode !== null || ownedRoot.signalCode !== null) return refusal("owned-root-exited-after-query");
  return { verified: true };
}

/** Run the one bounded lineage query and report a fixed stage on failure. */
async function runBoundedLineageQuery(
  powershell: string,
  script: string,
  execute: WindowsLineageQueryExecutor,
): Promise<{ ok: true; output: string } | { ok: false; reason: WindowsLineageRefusalReason }> {
  const witness: WindowsLineageQueryWitness = { timedOut: false, stdoutBytes: 0, stderrBytes: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<{ ok: true; output: string } | { ok: false; reason: WindowsLineageRefusalReason }>(
      (resolvePromise) => {
        let settled = false;
        let child: WindowsLineageQueryChild | undefined;
        // This module owns the deadline: the timer callback firing is the
        // positive timeout evidence, and it signals exactly the one child this
        // module started. Signalling is NOT settlement — completion still comes
        // from the executor's own callback, which is how the previous
        // execFile-owned `timeout` option behaved — so a child that ignores the
        // kill is never reported as finished while it may still be running.
        timer = setTimeout(() => {
          if (settled) return;
          witness.timedOut = true;
          try {
            child?.kill();
          } catch {
            // A failed signal changes nothing about the witnessed timeout and
            // must never become an uncaught exception on a timer callback; the
            // query still settles through its own callback below.
          }
        }, LINEAGE_QUERY_TIMEOUT_MS);
        timer.unref?.();
        const finish = (result: { ok: true; output: string } | { ok: false; reason: WindowsLineageRefusalReason }): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise(result);
        };
        child = execute(
          powershell,
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", maxBuffer: MAX_QUERY_OUTPUT_BYTES, windowsHide: true },
          (error, stdout) => {
            if (witness.timedOut) {
              // A timeout this module positively witnessed is final. Evidence
              // that lands after the deadline is never accepted — not even with
              // a null error — because the deadline only signalled the child.
              finish({ ok: false, reason: "query-timeout" });
            } else if (error) {
              // Output, command details, and host-specific paths are never
              // surfaced: only the fixed stage below leaves this module.
              finish({ ok: false, reason: classifyWindowsLineageQueryFailure(error, witness) });
            } else {
              finish({ ok: true, output: stdout });
            }
          },
        );
        const count = (stream: "stdoutBytes" | "stderrBytes") => (chunk: string | Buffer): void => {
          witness[stream] += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        };
        child?.stdout?.on("data", count("stdoutBytes"));
        child?.stderr?.on("data", count("stderrBytes"));
      },
    );
  } catch {
    // A synchronous executor failure means no bounded query child ran.
    clearTimeout(timer);
    return { ok: false, reason: "query-spawn-failed" };
  }
}

/**
 * The OS-level syscall codes Node reports in `error.code` when a child process
 * never started. Only one of these positively witnesses a spawn failure; any
 * other string code (a Node-internal `ERR_*` code, a host- or library-supplied
 * code, or anything unrecognized) says nothing about whether the child ever
 * started, so it stays an unclassified query failure rather than claiming a
 * spawn cause it cannot support.
 */
const WINDOWS_LINEAGE_SPAWN_FAILURE_CODES: readonly string[] = [
  "EACCES",
  "EAGAIN",
  "EBUSY",
  "EISDIR",
  "ELOOP",
  "EMFILE",
  "ENFILE",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOEXEC",
  "ENOMEM",
  "ENOTDIR",
  "EPERM",
  "ETXTBSY",
];

/**
 * Classify one bounded query failure from sanitized fields plus the witnessed
 * deadline/output evidence. `err.killed`, `err.signal`, and elapsed time are
 * deliberately never consulted, so a kill from any other source cannot be
 * reported as a timeout. The witnessed output bound is per stream, matching the
 * child's own `maxBuffer` semantics: two streams that are each within the bound
 * never override the real failure classification. A string `code` is attributed
 * to a failed spawn only when it is one of the known spawn syscall codes above.
 */
export function classifyWindowsLineageQueryFailure(
  error: unknown,
  witness: Readonly<WindowsLineageQueryWitness>,
): WindowsLineageRefusalReason {
  if (witness.timedOut) return "query-timeout";
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "query-output-cap";
  if (witness.stdoutBytes > MAX_QUERY_OUTPUT_BYTES || witness.stderrBytes > MAX_QUERY_OUTPUT_BYTES) {
    return "query-output-cap";
  }
  if (typeof code === "number") return "query-nonzero-exit";
  if (typeof code === "string" && WINDOWS_LINEAGE_SPAWN_FAILURE_CODES.includes(code)) return "query-spawn-failed";
  return "query-failed";
}

/** The bounded native ancestry script: PIDs and creation ticks in, nothing else out. */
function buildLineageScript(candidatePid: number, rootPid: number): string {
  const fail = (reason: WindowsLineageRefusalReason): string =>
    `[Console]::Out.WriteLine('${LINEAGE_FAILURE}:${reason}')`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$targetPid = ${candidatePid}`,
    `$rootPid = ${rootPid}`,
    // One initial request for the only two PIDs known before any walking. The
    // filter lists exactly those PIDs and nothing else, so the request can never
    // enumerate the host; the same three properties are read as by every later
    // lookup. The response is itself a bounded live snapshot, so its membership is
    // validated before any record is used: exactly one candidate row, at most one
    // owned-root row, and no row for any other PID. Records are bucketed and counted
    // in plain language — no extra cmdlet is resolved — so a duplicated, ambiguous,
    // or unexpected row can never be silently discarded in favour of a later row.
    '$initial = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = $targetPid OR ProcessId = $rootPid")',
    '$current = $null',
    '$initialRoot = $null',
    '$candidateRows = 0',
    '$rootRows = 0',
    '$unexpectedRows = 0',
    'foreach ($initialRecord in $initial) {',
    '  $observedPid = [long]$initialRecord.ProcessId',
    '  if ($observedPid -eq $targetPid) { $candidateRows += 1; $current = $initialRecord }',
    '  elseif ($observedPid -eq $rootPid) { $rootRows += 1; $initialRoot = $initialRecord }',
    '  else { $unexpectedRows += 1 }',
    '}',
    // A missing candidate keeps its original stage and stays ahead of every other
    // initial-batch refusal, so an unrelated or vanished candidate is reported
    // exactly as it was before this request was batched.
    `if ($null -eq $current) { ${fail("chain-candidate-record-missing")}; exit 0 }`,
    // A second candidate row or any row outside the two requested PIDs means this
    // snapshot is not the one the proof was built on. It is refused with the same
    // existing membership stage the fresh full-chain snapshot uses, never with a new
    // stage family, and never by quietly selecting one of the conflicting rows.
    `if ($candidateRows -gt 1 -or $unexpectedRows -gt 0) { ${fail("snapshot-count-mismatch")}; exit 0 }`,
    "$chain = New-Object System.Collections.ArrayList",
    "[void]$chain.Add([long]$targetPid)",
    "$records = New-Object System.Collections.ArrayList",
    "[void]$records.Add($current)",
    "$seen = @{}",
    "$seen[[string]$targetPid] = $true",
    `for ($step = 0; $step -lt ${MAX_ANCESTOR_STEPS}; $step++) {`,
    "  $parent = [long]$current.ParentProcessId",
    `  if ($parent -le 0) { ${fail("chain-parent-absent")}; exit 0 }`,
    `  if ($seen.ContainsKey([string]$parent)) { ${fail("chain-cycle")}; exit 0 }`,
    "  if ($parent -eq $rootPid) {",
    // The walk reached the owned root, so this verification's own initial root
    // observation becomes usable now — never before. It is usable only when that
    // observation was a single unambiguous row: no row, or more than one, refuses
    // here on the existing owned-root stage, so an ambiguous root never falls through
    // to the snapshot and an unrelated chain still keeps its own walk stages.
    // The record then goes through the unchanged fresh snapshot below, which
    // re-reads the root PID and compares its creation identity: a root that
    // exited or had its PID reused between the initial request and this moment
    // is refused there, and never accepted on the strength of the earlier row.
    `    if ($rootRows -ne 1) { ${fail("chain-owned-root-record-missing")}; exit 0 }`,
    "    $root = $initialRoot",
    "    [void]$chain.Add($rootPid)",
    "    [void]$records.Add($root)",
    "    $filter = ($chain | ForEach-Object { \"ProcessId = $_\" }) -join ' OR '",
    "    $liveProcesses = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter $filter)",
    `    if ($liveProcesses.Count -ne $chain.Count) { ${fail("snapshot-count-mismatch")}; exit 0 }`,
    "    $liveById = @{}",
    "    foreach ($record in $liveProcesses) { $liveById[[string]$record.ProcessId] = $record }",
    "    $consistent = $true",
    "    $stage = 'snapshot-creation-mismatch'",
    "    for ($index = 0; $index -lt $chain.Count; $index++) {",
    "      $record = $liveById[[string]$chain[$index]]",
    "      $observed = $records[$index]",
    `      if ($null -eq $record) { $stage = 'snapshot-record-missing'; $consistent = $false; break }`,
    "      if ($null -eq $observed.CreationDate -or $record.CreationDate -ne $observed.CreationDate) { $consistent = $false; break }",
    "      if ($index -lt $chain.Count - 1 -and ([long]$record.ParentProcessId -ne [long]$chain[$index + 1])) { $stage = 'snapshot-parent-incoherent'; $consistent = $false; break }",
    "    }",
    "    if ($consistent) {",
    "      $evidence = New-Object System.Collections.ArrayList",
    "      for ($index = 0; $index -lt $chain.Count; $index++) {",
    "        $record = $liveById[[string]$chain[$index]]",
    "        $observed = $records[$index]",
    "        $pidText = ([long]$chain[$index]).ToString([System.Globalization.CultureInfo]::InvariantCulture)",
    "        $parentText = ([long]$record.ParentProcessId).ToString([System.Globalization.CultureInfo]::InvariantCulture)",
    "        $initialTicks = $observed.CreationDate.ToUniversalTime().Ticks.ToString('D19', [System.Globalization.CultureInfo]::InvariantCulture)",
    "        $currentTicks = $record.CreationDate.ToUniversalTime().Ticks.ToString('D19', [System.Globalization.CultureInfo]::InvariantCulture)",
    '        [void]$evidence.Add("$pidText,$parentText,$initialTicks,$currentTicks")',
    "      }",
    "      [Console]::Out.WriteLine(($evidence -join ';'))",
    "      exit 0",
    "    }",
    `    [Console]::Out.WriteLine(\"${LINEAGE_FAILURE}:$\{stage\}\")`,
    "    exit 0",
    "  }",
    "  $seen[[string]$parent] = $true",
    "  [void]$chain.Add($parent)",
    '  $current = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = $parent"',
    `  if ($null -eq $current) { ${fail("chain-ancestor-record-missing")}; exit 0 }`,
    "  [void]$records.Add($current)",
    "}",
    fail("chain-depth-limit"),
  ].join("\n");
}

/** Validate bounded PID, parent-link, and creation-time evidence from CIM. */
export function classifyWindowsAncestryEvidence(
  output: string,
  candidatePid: number,
  rootPid: number,
): WindowsLineageVerification {
  if (!isPositivePid(candidatePid) || !isPositivePid(rootPid) || candidatePid === rootPid) {
    return refusal("evidence-identity-invalid");
  }
  const text = output.trim();
  if (text === LINEAGE_FAILURE) return refusal("sentinel-unrecognized");
  if (text.startsWith(LINEAGE_FAILURE_PREFIX)) {
    const stage = text.slice(LINEAGE_FAILURE_PREFIX.length);
    return refusal(isWindowsLineageNativeSentinelReason(stage) ? stage : "sentinel-unrecognized");
  }
  const rows = text.split(";");
  if (rows.length < 2 || rows.length > MAX_ANCESTOR_STEPS + 1) return refusal("evidence-bound-violation");
  const records: Array<{ pid: number; parentPid: number; creationTicks: string }> = [];
  for (const row of rows) {
    const [pidToken, parentToken, initialTicks, currentTicks, ...extra] = row.split(",");
    if (
      extra.length > 0
      || !pidToken || !/^[1-9]\d{0,9}$/.test(pidToken)
      || !parentToken || !/^[1-9]\d{0,9}$/.test(parentToken)
    ) return refusal("evidence-shape-invalid");
    if (!isValidCreationTicks(initialTicks) || !isValidCreationTicks(currentTicks)) {
      return refusal("evidence-shape-invalid");
    }
    if (initialTicks !== currentTicks) return refusal("evidence-snapshot-unstable");
    const pid = Number(pidToken);
    const parentPid = Number(parentToken);
    if (!isPositivePid(pid) || !isPositivePid(parentPid)) return refusal("evidence-shape-invalid");
    records.push({ pid, parentPid, creationTicks: currentTicks });
  }
  if (records[0]?.pid !== candidatePid) return refusal("evidence-candidate-mismatch");
  if (records[records.length - 1]?.pid !== rootPid) return refusal("evidence-owned-root-mismatch");
  if (new Set(records.map((record) => record.pid)).size !== records.length) return refusal("evidence-duplicate-pid");
  for (let index = 0; index < records.length - 1; index++) {
    const child = records[index];
    const parent = records[index + 1];
    if (child.parentPid !== parent.pid) return refusal("evidence-chain-broken");
    if (parent.creationTicks > child.creationTicks) return refusal("evidence-creation-order-invalid");
  }
  return { verified: true };
}

/** Boolean acceptance view of {@link classifyWindowsAncestryEvidence}. */
export function isVerifiedWindowsAncestryEvidence(
  output: string,
  candidatePid: number,
  rootPid: number,
): boolean {
  return classifyWindowsAncestryEvidence(output, candidatePid, rootPid).verified;
}

function isPositivePid(value: number | undefined): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= MAX_WINDOWS_PROCESS_ID;
}

function isValidCreationTicks(value: string | undefined): value is string {
  return typeof value === "string"
    && /^\d{19}$/.test(value)
    && value <= MAX_DATE_TIME_TICKS;
}
