import { execFile, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";

const LINEAGE_QUERY_TIMEOUT_MS = 5_000;
const MAX_ANCESTOR_STEPS = 64;
const MAX_QUERY_OUTPUT_BYTES = 4 * 1024;
const MAX_WINDOWS_PROCESS_ID = 0xffff_ffff;
const MAX_DATE_TIME_TICKS = "3155378975999999999";
const LINEAGE_FAILURE = "PI_REVIEW_GATE_LINEAGE_NO";

/**
 * Verify that `candidatePid` is a live strict descendant of an owned Windows
 * child process. The child PID remains the cleanup root; this bounded CIM
 * ancestry check identifies the Pi Node process behind a cmd.exe/npm shim
 * without inspecting command lines, paths, or shim contents.
 *
 * Any unavailable, malformed, timed-out, or oversized system response fails
 * closed. PowerShell receives only validated positive integer PIDs embedded as
 * decimal literals and walks at most 64 parent links. Its bounded output
 * contains only process IDs and creation-time ticks; the local validator checks
 * snapshot stability and rejects a parent created after its child, preventing
 * a recycled ancestor PID from satisfying proof.
 */
export async function isLiveWindowsProcessDescendant(
  ownedRoot: ChildProcess,
  candidatePid: number,
): Promise<boolean> {
  const rootPid = ownedRoot.pid;
  if (
    process.platform !== "win32"
    || !isPositivePid(rootPid)
    || !isPositivePid(candidatePid)
    || rootPid === candidatePid
    || ownedRoot.exitCode !== null
    || ownedRoot.signalCode !== null
  ) return false;

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) return false;
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `$targetPid = ${candidatePid}`,
    `$rootPid = ${rootPid}`,
    '$current = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = $targetPid"',
    "$chain = New-Object System.Collections.ArrayList",
    "[void]$chain.Add([long]$targetPid)",
    "$records = New-Object System.Collections.ArrayList",
    "if ($null -ne $current) { [void]$records.Add($current) }",
    "$seen = @{}",
    "$seen[[string]$targetPid] = $true",
    `for ($step = 0; $step -lt ${MAX_ANCESTOR_STEPS}; $step++) {`,
    "  if ($null -eq $current) { break }",
    "  $parent = [long]$current.ParentProcessId",
    "  if ($parent -le 0 -or $seen.ContainsKey([string]$parent)) { break }",
    "  if ($parent -eq $rootPid) {",
    '    $root = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = $rootPid"',
    "    if ($null -eq $root) { break }",
    "    [void]$chain.Add($rootPid)",
    "    [void]$records.Add($root)",
    "    $filter = ($chain | ForEach-Object { \"ProcessId = $_\" }) -join ' OR '",
    "    $liveProcesses = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter $filter)",
    "    if ($liveProcesses.Count -ne $chain.Count) { break }",
    "    $liveById = @{}",
    "    foreach ($record in $liveProcesses) { $liveById[[string]$record.ProcessId] = $record }",
    "    $consistent = $true",
    "    for ($index = 0; $index -lt $chain.Count; $index++) {",
    "      $record = $liveById[[string]$chain[$index]]",
    "      $observed = $records[$index]",
    "      if ($null -eq $record -or $null -eq $observed.CreationDate -or $record.CreationDate -ne $observed.CreationDate) { $consistent = $false; break }",
    "      if ($index -lt $chain.Count - 1 -and ([long]$record.ParentProcessId -ne [long]$chain[$index + 1])) { $consistent = $false; break }",
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
    "    break",
    "  }",
    "  $seen[[string]$parent] = $true",
    "  [void]$chain.Add($parent)",
    '  $current = Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate -Filter "ProcessId = $parent"',
    "  if ($null -ne $current) { [void]$records.Add($current) }",
    "}",
    `[Console]::Out.WriteLine('${LINEAGE_FAILURE}')`,
  ].join("\n");

  try {
    const output = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          maxBuffer: MAX_QUERY_OUTPUT_BYTES,
          timeout: LINEAGE_QUERY_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolvePromise(stdout);
        },
      );
    });
    return isVerifiedWindowsAncestryEvidence(output, candidatePid, rootPid)
      && ownedRoot.exitCode === null
      && ownedRoot.signalCode === null;
  } catch {
    // Do not surface PowerShell output, command details, or host-specific paths
    // through the receipt error path.
    return false;
  }
}

/** Validate bounded PID, parent-link, and creation-time evidence from CIM. */
export function isVerifiedWindowsAncestryEvidence(
  output: string,
  candidatePid: number,
  rootPid: number,
): boolean {
  if (!isPositivePid(candidatePid) || !isPositivePid(rootPid) || candidatePid === rootPid) return false;
  const rows = output.trim().split(";");
  if (rows.length < 2 || rows.length > MAX_ANCESTOR_STEPS + 1) return false;
  const records: Array<{ pid: number; parentPid: number; creationTicks: string }> = [];
  for (const row of rows) {
    const [pidToken, parentToken, initialTicks, currentTicks, ...extra] = row.split(",");
    if (
      extra.length > 0
      || !pidToken || !/^[1-9]\d{0,9}$/.test(pidToken)
      || !parentToken || !/^[1-9]\d{0,9}$/.test(parentToken)
      || !isValidCreationTicks(initialTicks)
      || !isValidCreationTicks(currentTicks)
      || initialTicks !== currentTicks
    ) return false;
    const pid = Number(pidToken);
    const parentPid = Number(parentToken);
    if (!isPositivePid(pid) || !isPositivePid(parentPid)) return false;
    records.push({ pid, parentPid, creationTicks: currentTicks });
  }
  if (
    records[0]?.pid !== candidatePid
    || records[records.length - 1]?.pid !== rootPid
    || new Set(records.map((record) => record.pid)).size !== records.length
  ) return false;
  for (let index = 0; index < records.length - 1; index++) {
    const child = records[index];
    const parent = records[index + 1];
    if (child.parentPid !== parent.pid || parent.creationTicks > child.creationTicks) return false;
  }
  return true;
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
