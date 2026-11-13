<#
.SYNOPSIS
  Observe the exit of one exact, caller-owned Windows process without controlling it.
.DESCRIPTION
  Windows PowerShell 5.1 / .NET Framework 4.8 public-API fixture. The caller must
  start this observer while its known-owned native child is alive, then validate
  the READY witness against that child's public spawn PID and current native
  ownership journal before allowing intentional shutdown. A READY witness alone
  is not proof of ownership or of native-session settlement.

  Stable invocation:
    -Root <existing absolute caller-owned directory>
    -NativePid <exact positive Int32 PID, at least 2>
    -RequestNonce <16-128 ASCII letters/digits/underscore/hyphen>
    [-ExpectedStartTimeUtcTicks <optional exact decimal Int64>]
    [-TimeoutSeconds <1..480, default 480>]

  Root must be a fully qualified drive path or complete UNC server/share path;
  drive-relative and current-drive-relative paths are rejected.
  RequestNonce is bounded routing/collision data, not authentication or a new
  protocol. ExpectedStartTimeUtcTicks, when supplied, is an exact comparison;
  no PID-reuse time tolerance is inferred. The caller supplies only its exact
  owned PID; this fixture does no name lookup, process enumeration, or adoption.

  The script creates <nonce>.ready.json and <nonce>.result.json in Root only.
  Both schemaVersion=1 objects carry requestNonce, observerPid, nativePid,
  nativeCreationTimeUtcTicks (decimal string when handle-bound, otherwise null),
  and state. READY uses state READY; result uses exited, unavailable, timed-out,
  or failure, with exitCode present only for exited. Both are CreateNew-only;
  each JSON payload is at most 1 KiB, and the script never replaces or removes a
  file. A consumer must treat a partially
  written witness as not-yet-readable and retry only within its own finite
  deadline. Observer exit code 0 means only that an exited result was published;
  the native process's actual code is the separate result.exitCode field. Any
  nonzero observer exit is fail-closed. The parent must validate its BigInt root
  identity before and after observation; this fixture does not derive
  filesystem identity from DirectoryInfo.FullName or timestamps. Retain
  witnesses for assertions and cleanup only after graceful owner settlement and
  exact root identity checks.

  Witness JSON is produced only by the built-in Microsoft.PowerShell.Utility
  serializer of the running host process. Before anything is published, the
  fixture pins that module by absolute path under $PSHOME, the running host's own
  installation directory, and every serializer call site uses the qualified
  Microsoft.PowerShell.Utility\ConvertTo-Json, so no unqualified command name can
  start ambient PowerShell module autoload or module-path discovery inside the
  publication path. A missing built-in module, a loaded same-named module with no
  filesystem identity, or one whose path lies outside $PSHOME, fails the run
  nonzero: no ambient or dynamic module is ever substituted, nothing is discovered
  instead, and no witness is published.

  For test-harness diagnosis only, the script writes fixed-vocabulary stage
  markers to STDERR: script-entered, root-validated, lookup-start, handle-bound,
  ready-published, and result-published. Each marker line is exactly
  'PRG-OBS-STAGE:<stage>' and carries no path, nonce, PID, error text, or other
  payload; STDOUT is never written. Markers are diagnosis only: they never
  satisfy readiness or exit, never replace a witness, and a missing marker is
  never evidence that the script did not start.

  Public API references (.NET Framework 4.8.1 reference pages, applicable to
  Windows PowerShell 5.1):
    Process.Handle: https://learn.microsoft.com/dotnet/api/system.diagnostics.process.handle?view=netframework-4.8.1
    Process.GetProcessById: https://learn.microsoft.com/dotnet/api/system.diagnostics.process.getprocessbyid?view=netframework-4.8.1
    Process.StartTime: https://learn.microsoft.com/dotnet/api/system.diagnostics.process.starttime?view=netframework-4.8.1
    Process.HasExited: https://learn.microsoft.com/dotnet/api/system.diagnostics.process.hasexited?view=netframework-4.8.1
    Process.WaitForExit(Int32): https://learn.microsoft.com/dotnet/api/system.diagnostics.process.waitforexit?view=netframework-4.8.1
    Process.ExitCode: https://learn.microsoft.com/dotnet/api/system.diagnostics.process.exitcode?view=netframework-4.8.1

  This is only an exact-process kernel-handle observer. It cannot establish
  node-pty exit/signal semantics, a public native session_shutdown/quit receipt,
  Main/outer exit codes, terminal restoration, or absence of forced cleanup.
  Same-user filesystem races are checked where possible but are not made an
  atomic sandbox by these public APIs, and this is not a malicious same-user
  isolation boundary. No Windows ACL-equivalence claim is made.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Root,

    [Parameter(Mandatory = $true)]
    [int] $NativePid,

    [Parameter(Mandatory = $true)]
    [string] $RequestNonce,

    [string] $ExpectedStartTimeUtcTicks,

    [ValidateRange(1, 480)]
    [int] $TimeoutSeconds = 480
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
# An omitted [string] parameter defaults to ''; only the bound-key test
# distinguishes omission from an explicitly supplied empty/invalid value.
$hasExpectedStartTime = $PSBoundParameters.ContainsKey('ExpectedStartTimeUtcTicks')

function Initialize-BuiltInJsonSerializer {
    # Witness JSON may only come from the built-in serializer of this exact host
    # process. An unqualified cmdlet name can start ambient PowerShell module
    # autoload and module-path discovery, so the built-in module is pinned here by
    # absolute path under $PSHOME, the running host's own installation directory,
    # and every serializer call site stays module-qualified. A missing built-in
    # module, or a same-named module loaded from outside $PSHOME, fails the run
    # before any witness exists; nothing is substituted and nothing is discovered.
    if ([string]::IsNullOrWhiteSpace($PSHOME)) {
        throw 'Built-in serialization module path is unavailable.'
    }
    $builtInManifest = [System.IO.Path]::Combine(
        $PSHOME,
        'Modules',
        'Microsoft.PowerShell.Utility',
        'Microsoft.PowerShell.Utility.psd1'
    )
    if (-not [System.IO.File]::Exists($builtInManifest)) {
        throw 'Built-in serialization module is missing.'
    }
    # Get-Module only inspects already-loaded modules, so this lookup itself can
    # never start module discovery.
    $loadedSerializerModule = Get-Module -Name 'Microsoft.PowerShell.Utility'
    if ($null -eq $loadedSerializerModule) {
        # Import-Module comes from the always-loaded core snapin, and an absolute
        # path inside $PSHOME loads this one module: neither searches a module path.
        $null = Import-Module -Name $builtInManifest -ErrorAction Stop
        $loadedSerializerModule = Get-Module -Name 'Microsoft.PowerShell.Utility'
        if ($null -eq $loadedSerializerModule) {
            throw 'Built-in serialization module could not be loaded.'
        }
    }
    # A module with no filesystem identity proves nothing: a dynamically created
    # same-named module (New-Module -Name Microsoft.PowerShell.Utility) has an empty
    # Path and could otherwise serve the witness. Only a module whose own path lies
    # inside this host's installation directory is the built-in serializer, so both
    # an empty path and a path elsewhere end the run before any witness exists.
    $loadedModulePath = [string] $loadedSerializerModule.Path
    if ([string]::IsNullOrEmpty($loadedModulePath)) {
        throw 'Loaded serialization module has no filesystem identity.'
    }
    if (-not $loadedModulePath.StartsWith($PSHOME + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Loaded serialization module is not the built-in one.'
    }
}

function Write-ObserverStageMarker {
    # Diagnosis only: one fixed-vocabulary line on STDERR, before and after the
    # exact-PID observation steps, so a caller can tell which step it reached.
    # It carries no path, nonce, PID, error text, or other payload, never writes
    # STDOUT, and a failed marker write never changes the observation itself.
    param([Parameter(Mandatory = $true)][string] $Stage)

    if ($Stage -notmatch '\A(?:script-entered|root-validated|lookup-start|handle-bound|ready-published|result-published)\z') {
        return
    }
    try {
        [System.Console]::Error.WriteLine('PRG-OBS-STAGE:' + $Stage)
    }
    catch {
        # A marker is never proof and never worth failing observation for.
    }
}

function Get-ValidatedRootPath {
    param([Parameter(Mandatory = $true)][string] $Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate.Length -gt 32767) {
        throw 'Invalid root path.'
    }
    # Path.IsPathRooted accepts drive-relative and current-drive-relative paths;
    # require a fully qualified drive root or a complete UNC server/share root.
    if ($Candidate.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $Candidate.StartsWith('\\.\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Device and extended paths are not supported.'
    }
    $isDriveAbsolute = $Candidate -match '\A[A-Za-z]:[\\/]'
    $isUncAbsolute = $Candidate -match '\A\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'
    if (-not ($isDriveAbsolute -or $isUncAbsolute) -or
        -not [System.IO.Path]::IsPathRooted($Candidate)) {
        throw 'Root must be a fully qualified drive or complete UNC path.'
    }

    $fullPath = [System.IO.Path]::GetFullPath($Candidate)
    if ($fullPath.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $fullPath.StartsWith('\\.\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Device and extended paths are not supported.'
    }

    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrEmpty($pathRoot)) {
        throw 'Root has no filesystem path root.'
    }
    $currentPath = $pathRoot
    $rootAttributes = [System.IO.File]::GetAttributes($currentPath)
    if (($rootAttributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or
        ($rootAttributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Root path traverses a non-directory or reparse point.'
    }

    $relativePath = $fullPath.Substring($pathRoot.Length)
    foreach ($segment in [regex]::Split($relativePath, '[\\/]')) {
        if ([string]::IsNullOrEmpty($segment)) {
            continue
        }
        $currentPath = [System.IO.Path]::Combine($currentPath, $segment)
        $attributes = [System.IO.File]::GetAttributes($currentPath)
        if (($attributes -band [System.IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Root path traverses a non-directory or reparse point.'
        }
    }

    return $fullPath
}

function New-WitnessPayload {
    param(
        [Parameter(Mandatory = $true)][string] $Nonce,
        [Parameter(Mandatory = $true)][int] $ObserverProcessId,
        [Parameter(Mandatory = $true)][int] $NativeProcessId,
        # Object typing preserves a true null for pre-binding/unavailable witnesses.
        [AllowNull()][object] $CreationTicks,
        [Parameter(Mandatory = $true)][string] $State,
        [AllowNull()][object] $ObservedExitCode
    )

    $payload = [ordered]@{
        schemaVersion = 1
        requestNonce = $Nonce
        observerPid = $ObserverProcessId
        nativePid = $NativeProcessId
        # A string preserves all Int64 ticks exactly; null means no handle-bound
        # creation time could be observed, so no incarnation claim is possible.
        nativeCreationTimeUtcTicks = $CreationTicks
        state = $State
    }
    if ($State -eq 'exited') {
        if ($null -eq $ObservedExitCode) {
            throw 'Exited state requires an observed exit code.'
        }
        $payload.exitCode = [int] $ObservedExitCode
    }
    return $payload
}

function Write-WitnessExclusive {
    param(
        [Parameter(Mandatory = $true)][string] $OriginalRoot,
        [Parameter(Mandatory = $true)][string] $ExpectedRoot,
        [Parameter(Mandatory = $true)][string] $Leaf,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary] $Payload
    )

    if ($Leaf -notmatch '\A[A-Za-z0-9_-]{16,128}\.(ready|result)\.json\z') {
        throw 'Invalid witness leaf.'
    }
    # Re-observe the existing root immediately before each publication. This
    # rejects symlink/junction/reparse descent but does not claim atomicity
    # against a same-user replacement race.
    $observedRoot = Get-ValidatedRootPath -Candidate $OriginalRoot
    if (-not [string]::Equals($observedRoot, $ExpectedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Root path changed during observation.'
    }
    $leafPath = [System.IO.Path]::Combine($observedRoot, $Leaf)
    if ([System.IO.File]::Exists($leafPath) -or [System.IO.Directory]::Exists($leafPath)) {
        throw 'Witness collision.'
    }

    # Module-qualified so the pinned built-in serializer is used and no unqualified
    # command name can start ambient module discovery inside the publication path.
    $json = Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $Payload -Compress -Depth 4
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
    if ($bytes.Length -gt 1024) {
        throw 'Witness exceeded its byte bound.'
    }
    $stream = $null
    try {
        # CreateNew is the final collision fence; no existing/unknown leaf is
        # opened, truncated, replaced, or deleted.
        $stream = [System.IO.File]::Open(
            $leafPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

$observerPid = 0
$expectedTicks = [long] 0
$rootPath = $null
$creationTicks = $null
$process = $null
$readyPublished = $false
$resultPublished = $false
$terminalState = 'failure'
$observedExitCode = $null
$scriptExitCode = 2
$canPublish = $false

Write-ObserverStageMarker -Stage 'script-entered'

try {
    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'This fixture requires Windows.'
    }
    # The built-in serializer is a publication prerequisite, so it is pinned before
    # anything could be published: a host without it fails nonzero with no witness.
    Initialize-BuiltInJsonSerializer
    if ($NativePid -lt 2 -or $NativePid -gt [int]::MaxValue) {
        throw 'NativePid must be an exact positive Int32 process ID.'
    }
    if ($RequestNonce -notmatch '\A[A-Za-z0-9_-]{16,128}\z') {
        throw 'RequestNonce must be 16-128 safe ASCII characters.'
    }
    if ($hasExpectedStartTime) {
        [long] $expectedTicks = 0
        if ($ExpectedStartTimeUtcTicks -notmatch '\A[0-9]{1,19}\z' -or
            -not [long]::TryParse(
                $ExpectedStartTimeUtcTicks,
                [System.Globalization.NumberStyles]::None,
                [System.Globalization.CultureInfo]::InvariantCulture,
                [ref] $expectedTicks
            ) -or
            $expectedTicks -le 0 -or
            $expectedTicks -gt [System.DateTime]::MaxValue.Ticks) {
            throw 'ExpectedStartTimeUtcTicks is invalid.'
        }
    }

    $rootPath = Get-ValidatedRootPath -Candidate $Root
    Write-ObserverStageMarker -Stage 'root-validated'
    $observerProcess = [System.Diagnostics.Process]::GetCurrentProcess()
    try {
        $observerPid = $observerProcess.Id
    }
    finally {
        $observerProcess.Dispose()
    }
    $canPublish = $true

    $readyLeaf = $RequestNonce + '.ready.json'
    $resultLeaf = $RequestNonce + '.result.json'
    $readyPath = [System.IO.Path]::Combine($rootPath, $readyLeaf)
    $resultPath = [System.IO.Path]::Combine($rootPath, $resultLeaf)
    if ([System.IO.File]::Exists($readyPath) -or [System.IO.Directory]::Exists($readyPath) -or
        [System.IO.File]::Exists($resultPath) -or [System.IO.Directory]::Exists($resultPath)) {
        throw 'Witness collision.'
    }

    # GetProcessById is the sole target lookup: the caller supplies one exact
    # PID that its own spawn/journal fence has already identified.
    $terminalState = 'unavailable'
    Write-ObserverStageMarker -Stage 'lookup-start'
    $process = [System.Diagnostics.Process]::GetProcessById($NativePid)
    # Force public handle acquisition now and retain this Process object until
    # after WaitForExit and ExitCode; later PID reuse cannot redirect that handle.
    $heldProcessHandle = $process.Handle
    Write-ObserverStageMarker -Stage 'handle-bound'
    if ($process.HasExited) {
        throw 'Target process already exited before handle binding.'
    }
    $creationTimeUtc = $process.StartTime.ToUniversalTime()
    $creationTicks = $creationTimeUtc.Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture)
    if ($hasExpectedStartTime -and $creationTimeUtc.Ticks -ne $expectedTicks) {
        $terminalState = 'failure'
        throw 'Target process creation time did not match the expected identity.'
    }
    if ($process.HasExited) {
        throw 'Target process exited before READY publication.'
    }

    $terminalState = 'READY'
    $readyPayload = New-WitnessPayload -Nonce $RequestNonce -ObserverProcessId $observerPid `
        -NativeProcessId $NativePid -CreationTicks $creationTicks -State 'READY' -ObservedExitCode $null
    Write-WitnessExclusive -OriginalRoot $Root -ExpectedRoot $rootPath -Leaf $readyLeaf -Payload $readyPayload
    $readyPublished = $true
    Write-ObserverStageMarker -Stage 'ready-published'
    $terminalState = 'failure'

    $deadline = [System.Diagnostics.Stopwatch]::StartNew()
    $remainingMilliseconds = ($TimeoutSeconds * 1000) - [int] [System.Math]::Floor($deadline.Elapsed.TotalMilliseconds)
    if ($remainingMilliseconds -gt 0 -and $process.WaitForExit($remainingMilliseconds)) {
        if ($process.HasExited) {
            # Read ExitCode from the same retained Process object/handle that
            # was bound before READY; never resolve NativePid after exit.
            $observedExitCode = [int] $process.ExitCode
            $terminalState = 'exited'
        }
        else {
            $terminalState = 'failure'
        }
    }
    else {
        $terminalState = 'timed-out'
    }
}
catch {
    $scriptExitCode = 2
    if ($terminalState -eq 'READY') {
        $terminalState = 'failure'
    }
}

# Preserve diagnostics inside the caller-owned root only. A collision, invalid
# root, or invalid nonce is never worked around by choosing another directory.
if ($canPublish -and -not $readyPublished) {
    try {
        $failedReady = New-WitnessPayload -Nonce $RequestNonce -ObserverProcessId $observerPid `
            -NativeProcessId $NativePid -CreationTicks $creationTicks -State $terminalState -ObservedExitCode $null
        Write-WitnessExclusive -OriginalRoot $Root -ExpectedRoot $rootPath `
            -Leaf ($RequestNonce + '.ready.json') -Payload $failedReady
        $readyPublished = $true
    }
    catch {
        $scriptExitCode = 2
    }
}
if ($canPublish -and -not $resultPublished) {
    try {
        $resultPayload = New-WitnessPayload -Nonce $RequestNonce -ObserverProcessId $observerPid `
            -NativeProcessId $NativePid -CreationTicks $creationTicks -State $terminalState `
            -ObservedExitCode $observedExitCode
        Write-WitnessExclusive -OriginalRoot $Root -ExpectedRoot $rootPath `
            -Leaf ($RequestNonce + '.result.json') -Payload $resultPayload
        $resultPublished = $true
        Write-ObserverStageMarker -Stage 'result-published'
    }
    catch {
        $scriptExitCode = 2
    }
}

if ($null -ne $process) {
    $process.Dispose()
}

if ($resultPublished -and $terminalState -eq 'exited') {
    $scriptExitCode = 0
}
else {
    $scriptExitCode = 2
    [System.Console]::Error.WriteLine('Exact-process exit observation did not complete successfully.')
}
exit $scriptExitCode
