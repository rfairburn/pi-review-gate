$ErrorActionPreference = 'Stop'
$CjsArguments = @($args)

# Defense in depth for direct helper invocation. The public .cmd rejects these
# before starting PowerShell; this helper still checks before any Node, network,
# or archive-tool child process of its own.
if (-not [string]::IsNullOrEmpty($env:PI_REVIEW_GATE_RUNTIME_ROLE)) {
  [Console]::Error.WriteLine('pi-review-sessions: unsupported role context (PI_REVIEW_GATE_RUNTIME_ROLE).')
  exit 1
}
if (-not [string]::IsNullOrEmpty($env:PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG)) {
  [Console]::Error.WriteLine('pi-review-sessions: unsupported role context (PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG).')
  exit 1
}
$env:PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP = $null
$env:PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE = $null
$env:PI_REVIEW_GATE_NODE_GENERATION = $null
$env:PI_REVIEW_GATE_NODE_HOLDER = $null

$CjsEntry = Join-Path $PSScriptRoot 'pi-review-sessions.cjs'
# Per-release-line Node security minimums (issue 489), mirroring meetsNodeFloor
# in pi-review-sessions.cjs. Ordered newest line first: any other major inherits
# the floor of the nearest listed lower line, so newer unlisted majors keep the
# existing policy and releases below Node 22 compare against the Node 22 floor.
$NodeLineFloors = @([version]'26.12.1', [version]'24.22.1', [version]'22.23.4')

# One cleanup pass (inventory plus every removal it attempts) shares this elapsed
# budget, so a large or deep generation cannot reset the clock per generation.
$script:NodeCleanupBudgetSeconds = 120
$script:NodeCleanupStopwatch = $null
$script:NodeCleanupStopped = $false
# Deletions performed by the current pass (pass-scope progress allowance).
$script:NodeCleanupProgress = 0
# Bounded owner record: `<pid>` plus an optional targeted birth identity.
$script:NodeOwnerBytes = 192
# A reused pid's birth is only "after" a record when clearly later than it.
$script:NodeOwnerBirthMarginSeconds = 2

function Test-NodeFloor([string]$VersionText) {
  if ($VersionText -cnotmatch '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$') {
    return $false
  }
  try {
    $candidate = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  } catch {
    return $false
  }
  $minimum = $NodeLineFloors[$NodeLineFloors.Count - 1]
  foreach ($floor in $NodeLineFloors) {
    if ($floor.Major -le $candidate.Major) { $minimum = $floor; break }
  }
  if ($candidate -lt $minimum) { return $false }
  if ($candidate -eq $minimum -and $Matches[4]) { return $false }
  return $true
}

function Get-NodeVersion([string]$Executable) {
  try {
    $output = @(& $Executable '--version' 2>$null)
    $status = $LASTEXITCODE
    if ($status -ne 0 -or $output.Count -ne 1 -or $output[0] -isnot [string]) { return $null }
    return [string]$output[0]
  } catch {
    return $null
  }
}

function ConvertTo-WindowsNativeArgument([string]$Argument) {
  # Quote one argv element using the Microsoft CRT parsing rules. Backslashes
  # before quotes and at the end of a quoted argument must be doubled.
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append([char]34)
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq [char]92) {
      $backslashes++
      continue
    }
    if ($character -eq [char]34) {
      for ($i = 0; $i -lt (2 * $backslashes + 1); $i++) { [void]$builder.Append([char]92) }
      [void]$builder.Append([char]34)
    } else {
      for ($i = 0; $i -lt $backslashes; $i++) { [void]$builder.Append([char]92) }
      [void]$builder.Append($character)
    }
    $backslashes = 0
  }
  for ($i = 0; $i -lt (2 * $backslashes); $i++) { [void]$builder.Append([char]92) }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function Start-SessionCjs([string]$Executable, [string]$NodeDirectory, [string[]]$Arguments) {
  if (-not [string]::IsNullOrEmpty($NodeDirectory)) {
    if ($null -eq $env:PATH) { $env:PATH = $NodeDirectory }
    else { $env:PATH = $NodeDirectory + ';' + $env:PATH }
  }
  $nativeArguments = @($CjsEntry) + @($Arguments)
  $encodedArguments = @($nativeArguments | ForEach-Object { ConvertTo-WindowsNativeArgument ([string]$_) })
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $Executable
  $startInfo.Arguments = [string]::Join(' ', [string[]]$encodedArguments)
  $startInfo.WorkingDirectory = [Environment]::CurrentDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $false
  $startInfo.RedirectStandardInput = $false
  $startInfo.RedirectStandardOutput = $false
  $startInfo.RedirectStandardError = $false
  $process = $null
  try {
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) { throw 'Native Node process could not be started.' }
    $process.WaitForExit()
    $status = $process.ExitCode
  } catch {
    [Console]::Error.WriteLine('pi-review-sessions: could not start or wait for the shared CJS process.')
    exit 1
  } finally {
    if ($null -ne $process) { $process.Dispose() }
  }
  if ($null -eq $status) { $status = 1 }
  exit $status
}

# Resolve only an actual node.exe application on PATH (not a .cmd/.ps1 shim).
# If it meets the stable floor, retain that exact runtime and the original PATH.
$PathNode = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $PathNode -and $PathNode.Source) {
  $PathVersion = Get-NodeVersion $PathNode.Source
  if ($null -ne $PathVersion -and (Test-NodeFloor $PathVersion)) {
    Start-SessionCjs $PathNode.Source $null $CjsArguments
  }
}

# Select only the official archive for the native Windows OS architecture.
$NativeArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if ([string]::IsNullOrEmpty($NativeArchitecture)) {
  $NativeArchitecture = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
}
if ([string]::IsNullOrEmpty($NativeArchitecture)) { $NativeArchitecture = '' }
switch ($NativeArchitecture.ToUpperInvariant()) {
  'AMD64' {
    $NodePlatform = 'win-x64'
    $NodeArchive = 'node-v22.23.4-win-x64.zip'
    $NodeSha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
  }
  'ARM64' {
    $NodePlatform = 'win-arm64'
    $NodeArchive = 'node-v22.23.4-win-arm64.zip'
    $NodeSha256 = 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111'
  }
  'X86' {
    $NodePlatform = 'win-x86'
    $NodeArchive = 'node-v22.23.4-win-x86.zip'
    $NodeSha256 = '7d6c4dce2ecccca46e3c4b3e43c8bebbd1969bd616fdb4fda1e8269171d9ccea'
  }
  default {
    [Console]::Error.WriteLine('pi-review-sessions: no pinned Node.js 22.23.4 archive is available for this Windows architecture.')
    exit 1
  }
}

function Get-AgentDirectory {
  $homeDirectory = $env:USERPROFILE
  if ([string]::IsNullOrEmpty($homeDirectory)) { $homeDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
  $override = $env:PI_CODING_AGENT_DIR
  if ([string]::IsNullOrEmpty($override)) {
    if ([string]::IsNullOrEmpty($homeDirectory)) { throw 'Cannot resolve the native Pi agent directory.' }
    return Join-Path (Join-Path $homeDirectory '.pi') 'agent'
  }
  $override = $override.Replace('/', '\')
  if ($override -eq '~') {
    if ([string]::IsNullOrEmpty($homeDirectory)) { throw 'Cannot resolve the native Pi agent directory.' }
    return $homeDirectory
  }
  if ($override.StartsWith('~\', [StringComparison]::Ordinal)) {
    if ([string]::IsNullOrEmpty($homeDirectory)) { throw 'Cannot resolve the native Pi agent directory.' }
    return Join-Path $homeDirectory $override.Substring(2)
  }
  return $override
}

function Get-ExistingAttributes([string]$Path) {
  try { return [IO.File]::GetAttributes($Path) }
  catch [IO.FileNotFoundException] { return $null }
  catch [IO.DirectoryNotFoundException] { return $null }
}

# In-memory P/Invoke: identities exist BEFORE admission or compiler scratch.
# Reflection.Emit works in Windows PowerShell 5.1 without Add-Type's disk compiler.
function Initialize-IdentityType {
  $name = New-Object Reflection.AssemblyName 'PiReviewGateNodeNative'
  if ($PSVersionTable.PSEdition -eq 'Core') {
    $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  } else {
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  }
  $module = $assembly.DefineDynamicModule('Native')
  $builder = $module.DefineType('PiReviewGateNodeIdentity', [Reflection.TypeAttributes]'Public, Sealed, Abstract')
  $attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  $methods = @(
    @('CreateFileW', [IntPtr], [Type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
    @('GetFileInformationByHandle', [bool], [Type[]]@([IntPtr], [IntPtr])),
    @('GetFileInformationByHandleEx', [bool], [Type[]]@([IntPtr], [uint32], [IntPtr], [uint32])),
    @('CloseHandle', [bool], [Type[]]@([IntPtr])),
    # Atomic no-overwrite publication of the canonical coordination record: the
    # complete record is written to a private candidate and hard-linked into
    # place, which fails when another holder already published.
    @('CreateHardLinkW', [bool], [Type[]]@([string], [string], [IntPtr])),
    # Exclusive secure-at-creation directory (session-host state, Refs #494).
    @('CreateDirectoryW', [bool], [Type[]]@([string], [IntPtr]))
  )
  foreach ($definition in $methods) {
    $method = $builder.DefinePInvokeMethod($definition[0], 'kernel32.dll', $attributes, [Reflection.CallingConventions]::Standard, $definition[1], $definition[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $script:IdentityType = $builder.CreateType()
}

function New-LiteralDirectory([string]$Path) {
  # With no -Name, New-Item creates the literal complete path. Without
  # -Force, existing paths fail rather than being reused or replaced.
  New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
}

function Get-PathIdentity([string]$Path) {
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Bootstrap path is missing or a reparse point.'
  }
  $handle = $script:IdentityType::CreateFileW($Path, 0x80, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
  if ($handle -eq [IntPtr]::new(-1)) { throw 'Cannot open bootstrap identity.' }
  $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
  $idBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
  try {
    if (-not $script:IdentityType::GetFileInformationByHandle($handle, $buffer)) { throw 'Cannot read bootstrap identity.' }
    # FILE_FLAG_OPEN_REPARSE_POINT + BACKUP_SEMANTICS, then handle attributes.
    $nativeAttributes = [Runtime.InteropServices.Marshal]::ReadInt32($buffer, 0)
    if (($nativeAttributes -band 0x400) -ne 0) { throw 'Native reparse point refused.' }
    # FILE_ID_INFO (class 18): preserve all 64 volume bits and all 128 file-ID
    # bits. Truncating ReFS/native IDs to the legacy 64-bit file index is unsafe.
    if (-not $script:IdentityType::GetFileInformationByHandleEx($handle, 18, $idBuffer, 24)) { throw 'Full native file identity is unavailable.' }
    $nativeId = New-Object byte[] 24
    [Runtime.InteropServices.Marshal]::Copy($idBuffer, $nativeId, 0, 24)
    $volume = ([BitConverter]::ToString($nativeId, 0, 8)).Replace('-', '').ToLowerInvariant()
    $fileId = ([BitConverter]::ToString($nativeId, 8, 16)).Replace('-', '').ToLowerInvariant()
    if ($fileId -eq ('0' * 32)) { throw 'Native identity is unavailable.' }
    return $volume + ':' + $fileId
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($idBuffer)
    [void]$script:IdentityType::CloseHandle($handle)
  }
}

function Assert-PathIdentity([string]$Path, [string]$Expected) {
  if ($null -ne $script:BootstrapCacheFence) { Assert-NodeFence $script:BootstrapCacheFence }
  return (Get-PathIdentity $Path) -ceq $Expected
}

# Create path components one at a time and reject reparse points. This does not
# claim protection against a malicious same-user process racing filesystem ops.
function Ensure-DirectoryTree([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  if ($fullPath -notmatch '^[A-Za-z]:\\' -or $Path -match ':[^\\/]') { throw 'Unsupported native path alias.' }
  foreach ($part in $Path.Substring([IO.Path]::GetPathRoot($Path).Length).Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
    # Lexical . and .. retain ordinary relative override semantics; reject
    # Windows trailing-dot/space, device-name and alternate-stream aliases.
    if ($part -eq '.' -or $part -eq '..') { continue }
    if ($part.EndsWith(' ') -or $part.EndsWith('.') -or $part.Contains(':') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') { throw 'Unsupported native path alias.' }
  }
  $root = [IO.Path]::GetPathRoot($fullPath)
  $current = $root
  $relative = $fullPath.Substring($root.Length)
  foreach ($part in $relative.Split([char[]]@('\', '/'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $part)
    $attributes = Get-ExistingAttributes $current
    if ($null -eq $attributes) {
      New-LiteralDirectory $current
      $attributes = Get-ExistingAttributes $current
    }
    if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Unsafe or non-directory path component.'
    }
  }
  return $fullPath
}

function New-ExclusiveDirectory([string]$Path) {
  # New-Item fails for an existing path; random collisions are preserved and
  # treated as failure rather than inspected, reused, or deleted.
  New-LiteralDirectory $Path
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Could not establish an exclusive ordinary directory.'
  }
}

function Assert-OrdinaryDirectory([string]$Path) {
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Unexpected directory in the fresh extraction.'
  }
}

function Assert-OrdinaryFile([string]$Path) {
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Unexpected file in the fresh extraction.'
  }
}

# Issue 344: reuse a completed fallback runtime instead of downloading,
# re-verifying, and re-extracting the pinned archive on every fallback launch.
# Pinned-digest verification and fresh extraction remain on ACTUAL installation
# or update. A current completed runtime is recognized by the recorded pinned
# identity, a direct-child generation path, an ordinary node.exe whose native
# identity is unchanged, its npm CLI, and one cheap version probe.
function Read-RuntimeMarker([string]$Path) {
  if (-not [IO.File]::Exists($Path)) { return $null }
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
  $record = @{}
  try {
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
      $separator = $line.IndexOf('=')
      if ($separator -le 0) { continue }
      $record[$line.Substring(0, $separator)] = $line.Substring($separator + 1)
    }
  } catch {
    return $null
  }
  return $record
}

function Test-CurrentFallbackRuntime([string]$CacheRoot) {
  $record = Read-RuntimeMarker (Join-Path $CacheRoot 'current-node.txt')
  if ($null -eq $record) { return $null }
  if ($record['version'] -cne '22.23.4' -or $record['platform'] -cne $NodePlatform -or $record['archive'] -cne $NodeArchive -or $record['sha256'] -cne $NodeSha256) { return $null }
  $generation = [string]$record['generation']
  if ($generation -notmatch '^(?:bootstrap[-.])[A-Za-z0-9-]+$') { return $null }
  $generationDirectory = Join-Path $CacheRoot $generation
  try { Assert-OrdinaryDirectory $generationDirectory } catch { return $null }
  $nodeRoot = Join-Path (Join-Path $generationDirectory 'extracted') ('node-v22.23.4-' + $NodePlatform)
  $nodeExe = Join-Path $nodeRoot 'node.exe'
  $npmCommand = Join-Path $nodeRoot 'npm.cmd'
  $npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
  try {
    # Every fixed ancestor must be a real directory; a replaced `extracted` (or a
    # deeper junction) would otherwise redirect execution outside the generation
    # while the recorded leaf identity still matches. No inventory is needed.
    foreach ($directory in @(
      (Join-Path $generationDirectory 'extracted'),
      $nodeRoot,
      (Join-Path $nodeRoot 'node_modules'),
      (Join-Path $nodeRoot 'node_modules\npm'),
      (Join-Path $nodeRoot 'node_modules\npm\bin')
    )) {
      Assert-OrdinaryDirectory $directory
    }
    Assert-OrdinaryFile $nodeExe
    Assert-OrdinaryFile $npmCommand
    Assert-OrdinaryFile $npmCli
    if ((Get-PathIdentity $nodeExe) -cne [string]$record['node_identity']) { return $null }
  } catch {
    return $null
  }
  $version = Get-NodeVersion $nodeExe
  if ($null -eq $version -or -not (Test-NodeFloor $version)) { return $null }
  return @{ NodeExe = $nodeExe; NodeRoot = $nodeRoot; Generation = $generation }
}

function Publish-RuntimeMarker([string]$CacheRoot, [string]$GenerationRoot) {
  # A valid competing completed record naming exactly this runtime is preserved.
  $markerPath = Join-Path $CacheRoot 'current-node.txt'
  $generation = [IO.Path]::GetFileName($GenerationRoot)
  $existing = Read-RuntimeMarker $markerPath
  if ($null -ne $existing -and $existing['version'] -ceq '22.23.4' -and $existing['platform'] -ceq $NodePlatform -and $existing['archive'] -ceq $NodeArchive -and $existing['sha256'] -ceq $NodeSha256 -and $existing['generation'] -ceq $generation) {
    return
  }
  $nodeExe = Join-Path (Join-Path (Join-Path $GenerationRoot 'extracted') ('node-v22.23.4-' + $NodePlatform)) 'node.exe'
  $identity = $null
  try { $identity = Get-PathIdentity $nodeExe } catch { return }
  $temporary = Join-Path $CacheRoot ('.current-node.' + [string]$PID + '.' + [Guid]::NewGuid().ToString('N'))
  $body = @(
    'schema=1',
    'version=22.23.4',
    ('platform=' + $NodePlatform),
    ('archive=' + $NodeArchive),
    ('sha256=' + $NodeSha256),
    ('generation=' + $generation),
    ('node_identity=' + $identity)
  ) -join "`n"
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($body + "`n")
    $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
    # A stale record (malformed, wrong pin, deleted generation, changed Node
    # identity) is replaced, so a stale marker can never force a download on
    # every later fallback launch. A valid record for another completed runtime
    # is a competing publication and is preserved.
    if ($null -ne $existing) {
      if ($null -ne (Test-CurrentFallbackRuntime $CacheRoot)) { return }
      try { [IO.File]::Delete($markerPath) } catch { }
    }
    try { [IO.File]::Move($temporary, $markerPath) } catch { }
  } catch {
  } finally {
    try { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } } catch { }
  }
}

function Protect-CachedFallbackRuntime([string]$CacheRoot, [string]$GenerationRoot, [string]$AgentDirectory) {
  # Publish this consumer's pid + targeted birth identity inside the GENERATION
  # (the direct child every reclamation route inspects), under the canonical
  # per-agent coordination entry that every destructive Node pass holds across
  # deletion. A busy entry is never bypassed by a best-effort publication: the
  # launch fails safely instead of using unprotected code. A record whose owner
  # is gone is reclaimed later, so no generation is permanently preserved.
  $chain = $null
  $coordination = $null
  try {
    $chain = Get-NodeFence $CacheRoot
    $script:NodeCleanupStopwatch = [Diagnostics.Stopwatch]::StartNew()
    $coordination = Enter-NodeCoordination $AgentDirectory
    if ($null -eq $coordination) { return $false }
    Assert-NodeFence $chain
    $selected = Test-CurrentFallbackRuntime $CacheRoot
    if ($null -eq $selected -or (Join-Path $CacheRoot $selected.Generation) -cne $GenerationRoot) { return $false }
    $nodeExe = Join-Path (Join-Path (Join-Path $GenerationRoot 'extracted') ('node-v22.23.4-' + $NodePlatform)) 'node.exe'
    try {
      Assert-OrdinaryDirectory $GenerationRoot
      Assert-OrdinaryFile $nodeExe
    } catch { return $false }
    $markerPath = Join-Path $GenerationRoot ('.consumer-' + [string]$PID + '-' + [Guid]::NewGuid().ToString('N'))
    $marker = $null
    try {
      $marker = [IO.File]::Open($markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    } catch { $marker = $null }
    if ($null -eq $marker) { return $false }
    try {
      $markerBody = [string]$PID + "`n" + (Get-NodeOwnerIdentity ([int]$PID)) + "`n"
      $markerBytes = [Text.Encoding]::UTF8.GetBytes($markerBody)
      $marker.Write($markerBytes, 0, $markerBytes.Length)
      $marker.Flush($true)
    } finally { $marker.Dispose() }
    return $true
  } catch {
    return $false
  } finally {
    Exit-NodeCoordination $coordination
    $script:NodeCleanupStopwatch = $null
    $script:NodeCleanupStopped = $false
  }
}

function Receive-OfficialArchive([string]$Url, [string]$Destination) {
  $request = [Net.HttpWebRequest]([Net.WebRequest]::Create($Url))
  $request.Method = 'GET'
  $request.AllowAutoRedirect = $false
  $request.Timeout = 15000
  $request.ReadWriteTimeout = 30000
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $response = $null
  $inputStream = $null
  $outputStream = $null
  try {
    $response = [Net.HttpWebResponse]$request.GetResponse()
    if ([int]$response.StatusCode -ne 200) { throw 'Unexpected HTTP status.' }
    if ($response.ContentLength -gt 268435456) { throw 'Archive is too large.' }
    $inputStream = $response.GetResponseStream()
    $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $buffer = New-Object byte[] 65536
    [long]$totalBytes = 0
    while ($true) {
      $remainingMilliseconds = 180000 - $timer.ElapsedMilliseconds
      if ($remainingMilliseconds -le 0) { throw 'Download deadline exceeded.' }
      $inputStream.ReadTimeout = [int][Math]::Min(30000, $remainingMilliseconds)
      $read = $inputStream.Read($buffer, 0, $buffer.Length)
      if ($read -le 0) { break }
      if ($timer.ElapsedMilliseconds -gt 180000) { throw 'Download deadline exceeded.' }
      $totalBytes += $read
      if ($totalBytes -gt 268435456) { throw 'Archive is too large.' }
      $outputStream.Write($buffer, 0, $read)
    }
    if ($timer.ElapsedMilliseconds -gt 180000) { throw 'Download deadline exceeded.' }
    if ($totalBytes -eq 0) { throw 'Empty archive.' }
  } finally {
    if ($null -ne $outputStream) { $outputStream.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
  }
}

function Get-Sha256([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $digest = $algorithm.ComputeHash($stream)
    return ([BitConverter]::ToString($digest)).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $algorithm.Dispose()
  }
}

function Ensure-ExtractDirectory([string]$Root, [string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped its extraction root.' }
  $relative = $pathFull.Substring($rootFull.Length)
  $current = $rootFull.TrimEnd('\')
  foreach ($part in $relative.Split([char[]]@('\'), [StringSplitOptions]::RemoveEmptyEntries)) {
    $current = [IO.Path]::Combine($current, $part)
    $attributes = Get-ExistingAttributes $current
    if ($null -eq $attributes) {
      New-LiteralDirectory $current
      $attributes = Get-ExistingAttributes $current
    }
    if ($null -eq $attributes -or ($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Archive path collided with a non-directory entry.'
    }
  }
}

function Expand-VerifiedZip([string]$Archive, [string]$Destination, [string]$ExpectedRoot) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $totalBytes = [long]0
  try {
    if ($zip.Entries.Count -gt 100000) { throw 'Archive has too many entries.' }
    foreach ($entry in $zip.Entries) {
      $name = [string]$entry.FullName
      if ([string]::IsNullOrEmpty($name) -or $name.Length -gt 2048 -or $name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/')) {
        throw 'Archive contains an invalid member name.'
      }
      if (-not $name.StartsWith($ExpectedRoot + '/', [StringComparison]::Ordinal)) { throw 'Archive contains an unexpected member.' }
      $directoryEntry = $name.EndsWith('/')
      $trimmed = if ($directoryEntry) { $name.Substring(0, $name.Length - 1) } else { $name }
      $parts = $trimmed.Split([char]'/')
      if ($parts.Count -lt 1 -or $parts[0] -cne $ExpectedRoot -or $parts -contains '.' -or $parts -contains '..' -or $parts -contains '') {
        throw 'Archive contains a traversal path.'
      }
      foreach ($part in $parts) {
        if ($part.EndsWith(' ') -or $part.EndsWith('.') -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') {
          throw 'Archive contains a Windows path alias.'
        }
      }
      if (-not $seen.Add($name)) { throw 'Archive contains duplicate or aliased member names.' }
      $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
      if ($unixMode -eq 0xA000 -or ($unixMode -ne 0 -and $unixMode -ne 0x8000 -and $unixMode -ne 0x4000)) {
        throw 'Archive contains a link or special-file member.'
      }
      if ($entry.Length -lt 0 -or $entry.Length -gt 536870912) { throw 'Archive member is too large.' }
      $totalBytes += $entry.Length
      if ($totalBytes -gt 1073741824) { throw 'Archive expands beyond its size limit.' }
      $relative = $name.Replace('/', '\')
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($Destination, $relative))
      $boundary = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
      if (-not $target.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped its extraction root.' }
      if ($directoryEntry) {
        Ensure-ExtractDirectory $Destination $target
        continue
      }
      $parent = [IO.Path]::GetDirectoryName($target)
      Ensure-ExtractDirectory $Destination $parent
      $entryStream = $null
      $output = $null
      try {
        $entryStream = $entry.Open()
        $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $buffer = New-Object byte[] 65536
        [long]$written = 0
        while (($read = $entryStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $written += $read
          if ($written -gt $entry.Length -or $written -gt 536870912) { throw 'Archive entry exceeded its declared size.' }
          $output.Write($buffer, 0, $read)
        }
        if ($written -ne $entry.Length) { throw 'Archive entry was truncated.' }
      } finally {
        if ($null -ne $output) { $output.Dispose() }
        if ($null -ne $entryStream) { $entryStream.Dispose() }
      }
    }
  } finally {
    $zip.Dispose()
  }
}

function Get-NodeFence([string]$Root) {
  $chain = @()
  $current = [IO.Path]::GetPathRoot($Root)
  $chain += ,@($current, (Get-PathIdentity $current))
  foreach ($part in $Root.Substring($current.Length).Split([char]'\')) {
    $current = [IO.Path]::Combine($current, $part)
    $chain += ,@($current, (Get-PathIdentity $current))
  }
  return ,$chain
}
function Assert-NodeFence($Chain) {
  foreach ($entry in $Chain) {
    if ((Get-PathIdentity $entry[0]) -cne $entry[1]) { throw 'Node cache ancestor identity changed.' }
  }
}
function Remove-NodeEntry([string]$Path) {
  # Bounded incremental native deletion of one designated cache generation, in
  # immediate postorder: every entry is deleted as it is visited and each
  # directory is removed as soon as its own subtree is empty. A pass that reaches
  # its runtime budget therefore always already deleted real content — including
  # whole directories — so a directory-only generation cannot spend every pass
  # merely collecting candidates. There is no whole-tree preflight and no depth or
  # entry quota. Reparse points (symlinks/junctions) are unlinked themselves, never
  # entered, so data outside the generation is untouched. Cleanup-specific:
  # nested subtrees inside this disposable generation are removed too.
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push(@{ Path = $Path; Entries = $null; Index = 0 })
  try {
    while ($stack.Count -gt 0) {
      if (-not (Test-NodeCleanupAllowsWork)) { $script:NodeCleanupStopped = $true; return $false }
      $frame = $stack.Peek()
      if ($null -eq $frame.Entries) {
        $attributes = Get-ExistingAttributes $frame.Path
        if ($null -eq $attributes) { [void]$stack.Pop(); continue }
        $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
        $isReparse = ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if ($isReparse) {
          if ($isDirectory) { [IO.Directory]::Delete($frame.Path, $false) } else { [IO.File]::Delete($frame.Path) }
          $script:NodeCleanupProgress++
          [void]$stack.Pop()
          continue
        }
        if (-not $isDirectory) {
          [IO.File]::Delete($frame.Path)
          $script:NodeCleanupProgress++
          [void]$stack.Pop()
          continue
        }
        $frame.Entries = @([IO.Directory]::EnumerateFileSystemEntries($frame.Path))
        $frame.Index = 0
      }
      if ($frame.Index -lt $frame.Entries.Count) {
        $child = $frame.Entries[$frame.Index]
        $frame.Index = $frame.Index + 1
        $childAttributes = Get-ExistingAttributes $child
        if ($null -eq $childAttributes) { continue }
        $childIsDirectory = ($childAttributes -band [IO.FileAttributes]::Directory) -ne 0
        $childIsReparse = ($childAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        if ($childIsReparse) {
          if ($childIsDirectory) { [IO.Directory]::Delete($child, $false) } else { [IO.File]::Delete($child) }
          $script:NodeCleanupProgress++
          continue
        }
        if ($childIsDirectory) {
          $stack.Push(@{ Path = $child; Entries = $null; Index = 0 })
          continue
        }
        [IO.File]::Delete($child)
        $script:NodeCleanupProgress++
        continue
      }
      [IO.Directory]::Delete($frame.Path, $false)
      $script:NodeCleanupProgress++
      [void]$stack.Pop()
    }
    return $true
  } catch { return $false }
}

function Test-NodeCleanupRunning {
  if ($null -eq $script:NodeCleanupStopwatch) { return $true }
  return ($script:NodeCleanupStopwatch.Elapsed.TotalSeconds -lt $script:NodeCleanupBudgetSeconds)
}

function Test-NodeCleanupAllowsWork {
  # The pass-level budget grants exactly one initial allowance: until the pass has
  # deleted real content it may run its next bounded unit, and after that every
  # unit is deadline checked. A pass therefore cannot be a zero-progress no-op,
  # and it cannot keep deleting past its budget once it has started.
  if ($script:NodeCleanupProgress -gt 0) { return (Test-NodeCleanupRunning) }
  return $true
}

function Test-NodeGenerationActive([string]$Path) {
  # True while a live producer or a live cached-runtime consumer owns this
  # generation. Fence the generation root first: a direct-child link/junction is
  # not a generation and its outside target must never be inspected. Invalid
  # marker shapes are not liveness evidence, and confined no-follow cleanup
  # handles them. Per-consumer `.consumer-<pid>-<guid>` records are evaluated
  # individually, so several consumers never clobber each other's protection.
  $rootAttributes = Get-ExistingAttributes $Path
  if ($null -eq $rootAttributes) { return $false }
  if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $marker = Join-Path $Path '.producer-active'
  $attributes = Get-ExistingAttributes $marker
  if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::Directory) -eq 0 -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    if (Test-NodeOwnerRecord $marker) { return $true }
    try { [IO.File]::Delete($marker) } catch { }
  }
  $active = $false
  try {
    foreach ($consumer in [IO.Directory]::EnumerateFiles($Path, '.consumer-*')) {
      $consumerAttributes = Get-ExistingAttributes $consumer
      if ($null -eq $consumerAttributes -or ($consumerAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
      if (Test-NodeOwnerRecord $consumer) {
        $active = $true
      } else {
        try { [IO.File]::Delete($consumer) } catch { }
      }
    }
  } catch {
  }
  return $active
}

function Read-NodeOwnerRecord([string]$Text) {
  # Parse one per-cache owner record: `<pid>` plus, for current producers, the
  # owner's targeted birth identity. A legacy pid-only record stays readable with
  # an empty identity.
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $newline = $Text.IndexOf("`n")
  $pidText = if ($newline -lt 0) { $Text.Trim() } else { $Text.Substring(0, $newline).Trim() }
  if ($pidText -notmatch '^[1-9]([0-9]{0,9})$') { return $null }
  $identity = if ($newline -lt 0) { '' } else { $Text.Substring($newline + 1).TrimEnd("`r", "`n") }
  return @{ Pid = [int]$pidText; Identity = $identity }
}

function Read-NodeOwnerRecordFile([string]$Path) {
  $info = $null
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes) { return $null }
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { return $null }
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
  try { $info = [IO.FileInfo]::new($Path) } catch { return $null }
  if ($info.Length -gt $script:NodeOwnerBytes) { return $null }
  $text = $null
  try { $text = [IO.File]::ReadAllText($Path) } catch { return $null }
  return (Read-NodeOwnerRecord $text)
}

function Test-NodeOwnerRecord([string]$Path) {
  # True only while a record's owner is genuinely current: a record carrying its
  # owner's birth identity is honored only while that exact identity still holds,
  # and a legacy pid-only record is honored while the live pid's OS birth is not
  # clearly AFTER the record's own mtime (a later birth means the number was
  # reused, while an earlier birth is legitimate in-flight work).
  $record = Read-NodeOwnerRecordFile $Path
  if ($null -eq $record) { return $false }
  $process = $null
  try { $process = Get-Process -Id $record.Pid -ErrorAction Stop } catch { return $false }
  if (-not [string]::IsNullOrEmpty($record.Identity)) {
    $observed = Get-NodeOwnerIdentity $record.Pid
    # A temporarily unavailable birth query is not a proven mismatch: the pid is
    # alive, so this may still be an in-flight producer and is honored.
    if ([string]::IsNullOrEmpty($observed)) { return $true }
    return ($observed -ceq $record.Identity)
  }
  $birth = $null
  try { $birth = $process.StartTime.ToUniversalTime() } catch { return $true }
  $written = $null
  try { $written = [IO.File]::GetLastWriteTimeUtc($Path) } catch { return $true }
  return ($birth -le $written.AddSeconds($script:NodeOwnerBirthMarginSeconds))
}

function Get-NodeLockToken([string]$Path, $Attributes) {
  # Best-effort identity of the exact lock entry without following links. A live
  # producer lock is always a freshly created regular file whose record metadata
  # differs from the observed malformed artifact, so a replacement is never
  # mistaken for the artifact that was observed.
  if ($null -eq $Attributes) { return $null }
  $token = 'attributes:' + [int]$Attributes
  $notDirectory = ($Attributes -band [IO.FileAttributes]::Directory) -eq 0
  $notReparse = ($Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0
  # One-line conjunctions only: Windows PowerShell 5.1 rejects a line that starts
  # with an operator (and the multiline form is not worth the parse risk).
  if ($notDirectory -and $notReparse) {
    try {
      $info = [IO.FileInfo]::new($Path)
      $token = $token + ':' + $info.Length + ':' + $info.LastWriteTimeUtc.Ticks
    } catch { return $null }
  }
  return $token
}

function Test-NodeHostOwnership([string]$AgentDirectory) {
  # Presence only: the session host's existing exclusive ownership record keeps
  # its authority. This never reads, steals, or repairs that record.
  if ([string]::IsNullOrEmpty($AgentDirectory)) { return $false }
  $ownership = Join-Path (Join-Path $AgentDirectory 'session-host') 'host-ownership.json'
  return ($null -ne (Get-ExistingAttributes $ownership))
}

function Get-NodeOwnerIdentity([int]$ProcessId) {
  # Targeted single-pid owner-lifetime identity (never a census): the process start
  # time as an invariant round-trip token, in the same `win32:<token>` format the
  # CJS and TypeScript writers query for one known pid. A reused pid reports a
  # different start time, so an abandoned record is reclaimed instead of gating
  # startup forever. An empty result means no record is published at all.
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return 'win32:' + $process.StartTime.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  } catch { return '' }
}

function Read-NodeCoordinationRecord([string]$Path) {
  # Returns @{ Pid; Identity } for a complete published record, or $null.
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes) { return $null }
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { return $null }
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $null }
  try { if (([IO.FileInfo]::new($Path)).Length -gt 192) { return $null } } catch { return $null }
  $text = $null
  try { $text = [IO.File]::ReadAllText($Path) } catch { return $null }
  if ([string]::IsNullOrEmpty($text)) { return $null }
  $newline = $text.IndexOf("`n")
  if ($newline -lt 0) { return $null }
  $pidText = $text.Substring(0, $newline).Trim()
  if ($pidText -notmatch '^[1-9]([0-9]{0,9})$') { return $null }
  $identity = $text.Substring($newline + 1).TrimEnd("`r", "`n")
  if ($identity.Length -gt 160) { return $null }
  return @{ Pid = [int]$pidText; Identity = $identity }
}

function Test-NodeCoordinationOwnerCurrent($Record) {
  # A record is honored only while its pid is alive AND still reports the recorded
  # start identity; a record without a birth identity is never honored.
  if ($null -eq $Record) { return $false }
  try { $null = Get-Process -Id $Record.Pid -ErrorAction Stop } catch { return $false }
  # A record without a birth identity is never honored on any platform: pid-only
  # metadata could otherwise be pinned forever behind an unrelated live process.
  if ([string]::IsNullOrEmpty($Record.Identity)) { return $false }
  $observed = Get-NodeOwnerIdentity $Record.Pid
  # A temporarily unavailable birth query is not a proven mismatch: the pid is
  # alive, so this may still be a live destructive holder and is honored rather
  # than stolen mid-deletion.
  if ([string]::IsNullOrEmpty($observed)) { return $true }
  return ($observed -ceq $Record.Identity)
}

function Publish-NodeCoordination([string]$StateDirectory) {
  # Write the complete record to a private candidate, then publish it with an
  # atomic no-overwrite hard link. A paused publisher therefore only loses the link
  # race and never exposes or adopts a half-written canonical entry. The owner
  # identity is required: a pid-only record would pin a later start behind a reused
  # pid forever, so nothing is published when the identity is unavailable.
  $identity = Get-NodeOwnerIdentity ([int]$PID)
  if ([string]::IsNullOrEmpty($identity)) { return 'failed' }
  $candidate = Join-Path $StateDirectory ('host-coordination.lock.' + [string]$PID + '.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  $body = [string]$PID + "`n" + $identity + "`n"
  try {
    $stream = [IO.File]::Open($candidate, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes($body)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
  } catch { return 'failed' }
  $entry = Join-Path $StateDirectory 'host-coordination.lock'
  $linked = $false
  try { $linked = $script:IdentityType::CreateHardLinkW($entry, $candidate, [IntPtr]::Zero) } catch { $linked = $false }
  try { [IO.File]::Delete($candidate) } catch { }
  if ($linked) { return 'published' }
  if ($null -ne (Get-ExistingAttributes $entry)) { return 'lost' }
  return 'failed'
}

function Remove-NodeCoordinationEntry([string]$Path, [string]$ExpectedIdentity) {
  # Remove exactly the observed entry name; a junction/link is unlinked itself,
  # never entered, and a directory shape is removed only when it is a metadata
  # entry this producer could have created.
  $current = $null
  try { $current = Get-PathIdentity $Path } catch { return $true }
  if ($null -ne $ExpectedIdentity -and $current -cne $ExpectedIdentity) { return $true }
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes) { return $true }
  try {
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
      [IO.Directory]::Delete($Path, $false)
    } else {
      [IO.File]::Delete($Path)
    }
    return $true
  } catch { return $false }
}

function New-PrivateStateDirectory([string]$Path) {
  # A genuinely absent session-host state directory is created exclusively with
  # a secure-at-creation descriptor (Refs #494): owned by this account, with a
  # protected DACL granting full control only to this account, LocalSystem, and
  # the built-in Administrators alias, so it never carries broad inherited
  # grants. CreateDirectoryW fails for any existing name, and an existing entry
  # is never inspected for repair, re-ACL'd, or re-owned. Any failure leaves the
  # caller's ordinary creation path below unchanged; the Network stores prove
  # protection themselves and refuse an unverified directory.
  if ($null -ne (Get-ExistingAttributes $Path)) { return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor ('O:' + $sid + 'D:P(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  $bytes = New-Object byte[] $descriptor.BinaryLength
  $descriptor.GetBinaryForm($bytes, 0)
  $saSize = 12
  if ([IntPtr]::Size -eq 8) { $saSize = 24 }
  $sd = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  $sa = [Runtime.InteropServices.Marshal]::AllocHGlobal($saSize)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $sd, $bytes.Length)
    # SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; }
    [Runtime.InteropServices.Marshal]::WriteInt32($sa, 0, $saSize)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($sa, [IntPtr]::Size, $sd)
    [Runtime.InteropServices.Marshal]::WriteInt32($sa, 2 * [IntPtr]::Size, 0)
    [void]$script:IdentityType::CreateDirectoryW($Path, $sa)
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($sa)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($sd)
  }
}

function Enter-NodeCoordination([string]$AgentDirectory) {
  # The one canonical per-agent mutex that host ownership acquisition also takes,
  # so destructive reclamation and a host becoming the owner are mutually
  # exclusive. Returns an object (Path/Identity) or $null when the boundary is
  # unavailable; that never refuses startup. A current holder is honored, and
  # stale/dead/reused-pid/malformed metadata is reclaimed.
  if ([string]::IsNullOrEmpty($AgentDirectory)) { return $null }
  $stateDirectory = Join-Path $AgentDirectory 'session-host'
  # Creation protection is additive: it never changes whether coordination proceeds.
  try {
    $agentFullPath = Ensure-DirectoryTree $AgentDirectory
    New-PrivateStateDirectory (Join-Path $agentFullPath 'session-host')
  } catch { }
  try { Ensure-DirectoryTree $stateDirectory | Out-Null } catch { return $null }
  $path = Join-Path $stateDirectory 'host-coordination.lock'
  $malformed = 0
  $observedToken = $null
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($null -eq (Get-ExistingAttributes $path)) {
      $published = Publish-NodeCoordination $stateDirectory
      if ($published -eq 'published') {
        $identity = $null
        try { $identity = Get-PathIdentity $path } catch { return $null }
        return @{ Path = $path; Identity = $identity }
      }
      if ($published -eq 'failed') { return $null }
      continue
    }
    # Capture the exact entry identity BEFORE reading/checking its owner: another
    # contender may replace stale metadata with its own live record in between, and
    # reclamation must stay bound to the entry that was actually judged stale.
    $current = $null
    try { $current = Get-PathIdentity $path } catch { $current = $null }
    if ($null -eq $current) {
      Start-Sleep -Milliseconds 25
      continue
    }
    $record = Read-NodeCoordinationRecord $path
    if ($null -ne $record -and (Test-NodeCoordinationOwnerCurrent $record)) {
      # A current holder: wait briefly, then this producer skips reclamation.
      $malformed = 0
      $observedToken = $null
      Start-Sleep -Milliseconds 50
      continue
    }
    if ($null -eq $record) {
      if ($current -cne $observedToken) { $malformed = 0; $observedToken = $current }
      $malformed++
      if ($malformed -lt 3) { Start-Sleep -Milliseconds 25; continue }
      $malformed = 0
      $observedToken = $null
    }
    if (-not (Remove-NodeCoordinationEntry $path $current)) { return $null }
  }
  return $null
}

function Exit-NodeCoordination($Coordination) {
  if ($null -eq $Coordination) { return }
  try {
    $record = Read-NodeCoordinationRecord $Coordination.Path
    if ($null -eq $record -or $record.Pid -ne $PID) { return }
    if ($record.Identity -cne (Get-NodeOwnerIdentity ([int]$PID))) { return }
    if ($null -ne $Coordination.Identity -and (Assert-PathIdentity $Coordination.Path $Coordination.Identity)) {
      [IO.File]::Delete($Coordination.Path)
    }
  } catch { # Uncertain coordination ownership is retained for stale recovery.
  }
}

function Invoke-NodeCacheCleanup([string]$Root, $Chain, $Lock, [string]$AgentDirectory, [int]$Target = 5, [string]$Keep = '') {
  # Best-effort cleanup only: every failure here warns and creation proceeds.
  # Ownership of the admission entry is not this pass's business: the identity
  # captured when acquisition succeeded is what release is bound to, so skipping
  # or failing reclamation never strands the producer's own metadata entry.
  try {
    # The record is written already complete: this producer's pid plus its
    # targeted birth identity, so liveness never depends on a pid number alone.
    $recordBody = [string]$PID + "`n" + (Get-NodeOwnerIdentity ([int]$PID)) + "`n"
    $lockBytes = [Text.Encoding]::UTF8.GetBytes($recordBody)
    $Lock.Write($lockBytes, 0, $lockBytes.Length)
    $Lock.Flush($true)
    Assert-NodeFence $Chain
    $entries = @()
    try {
      $entries = @([IO.Directory]::EnumerateFileSystemEntries($Root))
    } catch {
      [Console]::Error.WriteLine('pi-review-sessions: Node cache inventory was unavailable; continuing without reclamation.')
    }
    $count = 0
    foreach ($entry in $entries) {
      $entryName = [IO.Path]::GetFileName($entry)
      if ($entryName -ceq '.admission.lock' -or $entryName -ceq 'current-node.txt') { continue }
      if (-not [string]::IsNullOrEmpty($Keep) -and $entry -ceq $Keep) { continue }
      $count++
    }
    # The pass shares this one elapsed budget (admission wait plus every removal
    # it attempts) and one progress allowance, so neither a large generation nor a
    # long run of tiny ones can reset the clock or continue past it.
    $script:NodeCleanupStopped = $false
    $script:NodeCleanupProgress = 0
    $reclaimed = 0
    # $Target is the total number of generations this pass may leave. The kept
    # generation is excluded from $count, so the removable-candidate target is one
    # lower when a keep root is supplied, and the stopping condition is inclusive.
    $candidateTarget = $Target
    if (-not [string]::IsNullOrEmpty($Keep)) { $candidateTarget-- }
    foreach ($entry in $entries) {
      if ($count -le $candidateTarget) { break }
      $name = [IO.Path]::GetFileName($entry)
      if ($name -ceq '.admission.lock' -or $name -ceq 'current-node.txt') { continue }
      if (-not [string]::IsNullOrEmpty($Keep) -and $entry -ceq $Keep) { continue }
      if (($script:NodeCleanupProgress -gt 0) -and -not (Test-NodeCleanupRunning)) {
        # This pass already deleted something and has reached its budget: never
        # start another candidate while the canonical entry is still held.
        break
      }
      # Rechecked at every destructive boundary: even when the per-agent boundary
      # could not be taken, a host's ownership record stops further removal
      # instead of being raced by cleanup.
      if (Test-NodeHostOwnership $AgentDirectory) {
        [Console]::Error.WriteLine('pi-review-sessions: a session host acquired the agent directory during cleanup; leaving the remaining Node cache generations untouched.')
        break
      }
      if (Test-NodeGenerationActive $entry) { continue }
      if (Remove-NodeEntry $entry) {
        $count--
        $reclaimed++
      } elseif ($script:NodeCleanupStopped) {
        # Real content was already deleted; the next launch continues from what
        # remains instead of repeating a no-op preflight forever.
        $script:NodeCleanupStopped = $false
        [Console]::Error.WriteLine("pi-review-sessions: Node cache cleanup stopped at its runtime budget after reclaiming $reclaimed generations; $count remain and the next launch reclaims more. Continuing startup.")
        break
      }
    }
    $held = $count
    if (-not [string]::IsNullOrEmpty($Keep)) { $held = $count + 1 }
    if ($held -gt $Target) {
      [Console]::Error.WriteLine("pi-review-sessions: Node cache still holds $held generations (target $Target); continuing startup.")
    }
    Assert-NodeFence $Chain
  } catch {
    [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup could not complete; continuing startup.')
  }
}

function Enter-NodeAdmissionLock([string]$Root, $Chain, [string]$AgentDirectory) {
  # Bounded exclusive acquisition of the per-cache admission lock entry. A live
  # owner is waited for briefly and then left alone, a dead/malformed/non-live
  # artifact is reclaimed confined to that exact entry, and nothing here can become
  # a permanent stop condition. Returns @{ Stream; Path; Identity } or $null, and
  # records why in $script:NodeLockReport ('busy' or 'artifact').
  $lockPath = Join-Path $Root '.admission.lock'
  $lock = $null
  $lockReclaimFailed = $false
  $script:NodeLockReport = 'busy'
  try { Assert-NodeFence $Chain } catch { return $null }
  $malformedLock = 0
  $observedLockToken = $null
  for ($attempt = 0; $attempt -lt 40 -and $null -eq $lock; $attempt++) {
    try {
      $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    } catch {
      try {
        $lockAttributes = Get-ExistingAttributes $lockPath
        if ($null -eq $lockAttributes) {
          # Another producer settled between attempts; retry creation.
          $malformedLock = 0
          $observedLockToken = $null
          Start-Sleep -Milliseconds 25
          continue
        }
        $lockIsReparse = ($lockAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
        $lockIsDirectory = ($lockAttributes -band [IO.FileAttributes]::Directory) -ne 0
        # Keep each expression on one line: Windows PowerShell 5.1 rejects a
        # continuation line that begins with -or.
        $lockShape = $lockIsReparse -or $lockIsDirectory
        if (-not $lockShape) {
          try { $lockShape = (([IO.FileInfo]::new($lockPath)).Length -gt $script:NodeOwnerBytes) } catch { $lockShape = $true }
        }
        $lockRecord = $null
        if (-not $lockShape) { $lockRecord = Read-NodeOwnerRecordFile $lockPath }
        $lockToken = Get-NodeLockToken $lockPath $lockAttributes
        if ($null -ne $lockRecord) {
          $malformedLock = 0
          # A genuinely current owner is waited for; this producer then skips
          # cleanup. A dead, pid-reused, or pid-only-stale record is not a
          # current owner and is reclaimed below.
          if (Test-NodeOwnerRecord $lockPath) { $observedLockToken = $null; Start-Sleep -Milliseconds 50; continue }
          # A dead or reused owner's record is reclaimed only if it is still
          # that entry.
          if ($null -eq $lockToken) { $observedLockToken = $null; Start-Sleep -Milliseconds 25; continue }
          $observedLockToken = $lockToken
        } else {
          # A just-created lock can be read before its pid is written; only the
          # SAME malformed artifact, observed across several inspections, is a
          # dead owner's residue.
          if ($null -eq $lockToken) { $observedLockToken = $null; Start-Sleep -Milliseconds 50; continue }
          if ($lockToken -cne $observedLockToken) { $malformedLock = 0; $observedLockToken = $lockToken }
          $malformedLock++
          if ($malformedLock -lt 3) { Start-Sleep -Milliseconds 50; continue }
          $malformedLock = 0
        }
        # Reclaim only the exact artifact that was observed: anything that now
        # occupies the path is left in place and acquisition restarts.
        $currentToken = Get-NodeLockToken $lockPath (Get-ExistingAttributes $lockPath)
        if ($null -eq $currentToken -or $currentToken -cne $observedLockToken) {
          $observedLockToken = $null
          Start-Sleep -Milliseconds 25
          continue
        }
        $observedLockToken = $null
        if (-not (Remove-NodeEntry $lockPath)) { $lockReclaimFailed = $true; break }
        continue
      } catch { break }
    }
  }
  if ($null -eq $lock) {
    if ($lockReclaimFailed) { $script:NodeLockReport = 'artifact' }
    return $null
  }
  # Capture the exact identity of the entry this producer just created, as part
  # of the successful acquisition itself. Release is bound to that entry whether
  # or not reclamation runs and whether or not a complete owner record is ever
  # written, so a fresh empty entry of this producer's own is never stranded; an
  # entry that later occupies the path has a different identity and is kept.
  $identity = $null
  try { $identity = Get-PathIdentity $lockPath } catch { $identity = $null }
  return @{ Stream = $lock; Path = $lockPath; Identity = $identity }
}

function Exit-NodeAdmissionLock($Admission, $Chain) {
  # Release only this producer's own admission entry: the exact entry identity
  # captured when that acquisition succeeded. Nothing is inferred from a written
  # owner record or from whether reclamation ran, so a skipped cleanup (host
  # ownership, contention) still releases this producer's own fresh metadata, and
  # a replacement now occupying the path has a different identity and is kept.
  if ($null -eq $Admission) { return }
  try { $Admission.Stream.Dispose() } catch { }
  try {
    if ($null -eq $Admission.Identity) { return }
    Assert-NodeFence $Chain
    if (Assert-PathIdentity $Admission.Path $Admission.Identity) { [IO.File]::Delete($Admission.Path) }
  } catch { # Uncertain lock ownership is retained.
  }
}

function Invoke-NodeSettlementCleanup([string]$Root, [string]$AgentDirectory, [string]$Keep) {
  # Producer-owned cleanup-only settlement retry: reclamation that contention
  # deferred while this producer was preparing is retried exactly once here, joined
  # (never backgrounded), under the same canonical per-agent coordination entry and
  # admission lock, targeting five and preserving the generation this launch
  # selected or created. Nothing is created, and capacity never refuses anything.
  $admission = $null
  try {
    $chain = Get-NodeFence $Root
    $coordination = Enter-NodeCoordination $AgentDirectory
    if ($null -eq $coordination) {
      [Console]::Error.WriteLine('pi-review-sessions: host ownership coordination was unavailable; leaving Node cache generations untouched.')
      return
    }
    try {
      if (Test-NodeHostOwnership $AgentDirectory) {
        [Console]::Error.WriteLine('pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.')
        return
      }
      $script:NodeCleanupStopwatch = [Diagnostics.Stopwatch]::StartNew()
      $admission = Enter-NodeAdmissionLock $Root $chain $AgentDirectory
      if ($null -eq $admission) {
        if ($script:NodeLockReport -eq 'artifact') {
          [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup lock artifact could not be removed; continuing without reclaiming older generations.')
        } else {
          [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.')
        }
        return
      }
      if (Test-NodeHostOwnership $AgentDirectory) {
        [Console]::Error.WriteLine('pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.')
        return
      }
      $null = Invoke-NodeCacheCleanup $Root $chain $admission.Stream $AgentDirectory 5 $Keep
    } finally {
      Exit-NodeAdmissionLock $admission $chain
      Exit-NodeCoordination $coordination
      $script:NodeCleanupStopwatch = $null
      $script:NodeCleanupStopped = $false
      $script:NodeCleanupProgress = 0
    }
  } catch {
    [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup could not complete; continuing startup.')
  }
}

function New-NodeGeneration([string]$Root, [string]$AgentDirectory, [string]$Keep = '') {
  $chain = Get-NodeFence $Root
  $admission = $null
  $skipCleanup = $false
  # The canonical per-agent coordination entry is taken FIRST and released once
  # this producer's fresh generation exists. Host ownership acquisition takes the
  # same entry, so cleanup and acquiring ownership cannot interleave.
  $coordination = Enter-NodeCoordination $AgentDirectory
  if ($null -eq $coordination) {
    $skipCleanup = $true
    [Console]::Error.WriteLine('pi-review-sessions: host ownership coordination was unavailable; leaving Node cache generations untouched.')
  } elseif (Test-NodeHostOwnership $AgentDirectory) {
    # An existing session host owns this agent directory: its cache generations
    # are left alone, while startup still proceeds.
    $skipCleanup = $true
    [Console]::Error.WriteLine('pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.')
  }
  try {
    Assert-NodeFence $chain
    # One elapsed budget for this whole admission pass: lock recovery and
    # reclamation both check it as they delete, and reaching it never refuses
    # creation.
    $script:NodeCleanupStopwatch = [Diagnostics.Stopwatch]::StartNew()
    # One short exclusive admission lock coordinates cleanup and creation. A
    # lock whose recorded owner is gone (or whose record is empty/malformed) is
    # reclaimed; a live owner is left alone and this producer then skips cleanup.
    # A stale/malformed NON-LIVE metadata shape (directory, junction, oversized or
    # unreadable) is removed confined to this exact lock path: this producer only
    # creates a fresh regular lock file, so such a shape is never live-producer
    # evidence. Capacity never refuses creation.
    if (-not $skipCleanup) {
      $admission = Enter-NodeAdmissionLock $Root $chain $AgentDirectory
    }
    if ($null -eq $admission -and -not $skipCleanup) {
      # Rechecked whichever way the admission attempt ended: a host that became
      # the owner while this producer waited is the reason cleanup stays away.
      if (Test-NodeHostOwnership $AgentDirectory) {
        [Console]::Error.WriteLine('pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.')
      } elseif ($script:NodeLockReport -eq 'artifact') {
        [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup lock artifact could not be removed; continuing without reclaiming older generations.')
      } else {
        [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.')
      }
    } elseif ($null -ne $admission) {
      if (Test-NodeHostOwnership $AgentDirectory) {
        # Rechecked after the admission wait/stale-lock recovery: a host may have
        # acquired ownership while this producer waited. Reclamation is skipped,
        # while the entry this producer already acquired is still its own to
        # release (see the finally block).
        [Console]::Error.WriteLine('pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.')
      } else {
        $null = Invoke-NodeCacheCleanup $Root $chain $admission.Stream $AgentDirectory 4 $Keep
      }
    }
    $candidate = Join-Path $Root ('bootstrap-' + [Guid]::NewGuid().ToString('N'))
    New-ExclusiveDirectory $candidate
    Assert-NodeFence $chain
    # The generation is disposable by location; no lifetime record is written.
    # A live owner marker keeps other producers from pruning it while the Node
    # archive is still being downloaded/extracted. The record carries this
    # producer's pid and targeted birth identity so a reused pid can never pin it.
    $markerPath = Join-Path $candidate '.producer-active'
    $marker = [IO.File]::Open($markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $markerBody = [string]$PID + "`n" + (Get-NodeOwnerIdentity ([int]$PID)) + "`n"
      $markerBytes = [Text.Encoding]::UTF8.GetBytes($markerBody)
      $marker.Write($markerBytes, 0, $markerBytes.Length)
      $marker.Flush($true)
    } finally { $marker.Dispose() }
    return $candidate
  } finally {
    $script:NodeCleanupStopwatch = $null
    $script:NodeCleanupStopped = $false
    # Release in reverse acquisition order: the per-cache admission entry first,
    # then the canonical per-agent entry. This producer's fresh generation already
    # carries its own liveness marker, so nothing it needs pruning is exposed.
    Exit-NodeAdmissionLock $admission $chain
    Exit-NodeCoordination $coordination
  }
}

$WorkRoot = $null
$script:NodeGenerationMarker = $null
try {
  $agentDirectory = Get-AgentDirectory
  $cacheRoot = Ensure-DirectoryTree (Join-Path (Join-Path $agentDirectory '.pi-review-gate') 'node')
  Initialize-IdentityType
  $script:BootstrapCacheFence = Get-NodeFence $cacheRoot
  # A previously completed runtime is reused when it is still current: no
  # download, no re-verification, no extraction, and no tree scan.
  $currentRuntime = Test-CurrentFallbackRuntime $cacheRoot
  if ($null -ne $currentRuntime) {
    if (-not (Protect-CachedFallbackRuntime $cacheRoot (Join-Path $cacheRoot $currentRuntime.Generation) $agentDirectory)) {
      throw 'Cached Node coordination was unavailable.'
    }
    Start-SessionCjs $currentRuntime.NodeExe $currentRuntime.NodeRoot $CjsArguments
  }
  # Keep the currently marked generation protected while this launch installs
  # its replacement, so a reusable runtime is never reclaimed before the new one
  # is complete.
  $keepPath = ''
  $keepRecord = Read-RuntimeMarker (Join-Path $cacheRoot 'current-node.txt')
  if ($null -ne $keepRecord) {
    $keepGeneration = [string]$keepRecord['generation']
    if ($keepGeneration -match '^(?:bootstrap[-.])[A-Za-z0-9-]+$') {
      $keepCandidate = Join-Path $cacheRoot $keepGeneration
      try { Assert-OrdinaryDirectory $keepCandidate; $keepPath = $keepCandidate } catch { }
    }
  }
  $WorkRoot = New-NodeGeneration $cacheRoot $agentDirectory $keepPath
  $script:NodeGenerationMarker = Join-Path $WorkRoot '.producer-active'
  $cacheIdentity = Get-PathIdentity $cacheRoot
  $workIdentity = Get-PathIdentity $WorkRoot
  $archivePath = Join-Path $WorkRoot $NodeArchive
  $extractRoot = Join-Path $WorkRoot 'extracted'
  New-ExclusiveDirectory $extractRoot
  $extractIdentity = Get-PathIdentity $extractRoot

  # This is the sole download URL; redirects and caller-controlled URLs are
  # rejected. The downloader has both elapsed-time and byte limits.
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity)) { throw 'Bootstrap root identity changed before download.' }
  $url = 'https://nodejs.org/dist/v22.23.4/' + $NodeArchive
  Receive-OfficialArchive $url $archivePath
  Assert-OrdinaryFile $archivePath
  $archiveIdentity = Get-PathIdentity $archivePath
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $extractRoot $extractIdentity) -or -not (Assert-PathIdentity $archivePath $archiveIdentity)) { throw 'Bootstrap path identity changed after download.' }
  $actualSha256 = Get-Sha256 $archivePath
  if ($actualSha256 -cne $NodeSha256) { throw 'Official Node archive checksum mismatch.' }
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $archivePath $archiveIdentity)) { throw 'Archive identity changed after checksum verification.' }

  $expectedRoot = 'node-v22.23.4-' + $NodePlatform
  Expand-VerifiedZip $archivePath $extractRoot $expectedRoot
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $extractRoot $extractIdentity) -or -not (Assert-PathIdentity $archivePath $archiveIdentity)) { throw 'Extraction ownership changed.' }
  $nodeRoot = Join-Path $extractRoot $expectedRoot
  $nodeExe = Join-Path $nodeRoot 'node.exe'
  $npmCommand = Join-Path $nodeRoot 'npm.cmd'
  $npmRoot = Join-Path $nodeRoot 'node_modules\npm'
  $npmCli = Join-Path $npmRoot 'bin\npm-cli.js'
  Assert-OrdinaryDirectory $extractRoot
  Assert-OrdinaryDirectory $nodeRoot
  Assert-OrdinaryDirectory (Join-Path $nodeRoot 'node_modules')
  Assert-OrdinaryDirectory $npmRoot
  Assert-OrdinaryDirectory (Join-Path $npmRoot 'bin')
  Assert-OrdinaryFile $nodeExe
  Assert-OrdinaryFile $npmCommand
  Assert-OrdinaryFile $npmCli
  $nodeIdentity = Get-PathIdentity $nodeExe

  # No unverified or pre-existing runtime is executed. This is the first
  # invocation of the fresh node.exe, after fixed-pin verification/extraction.
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $extractRoot $extractIdentity) -or -not (Assert-PathIdentity $nodeExe $nodeIdentity)) { throw 'Node executable identity changed before its version probe.' }
  $bootstrappedVersion = Get-NodeVersion $nodeExe
  if ($null -eq $bootstrappedVersion -or -not (Test-NodeFloor $bootstrappedVersion)) {
    throw 'Verified Node executable did not report a supported version.'
  }
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $extractRoot $extractIdentity) -or -not (Assert-PathIdentity $nodeExe $nodeIdentity)) { throw 'Node executable identity changed after its version probe.' }
  Publish-RuntimeMarker $cacheRoot $WorkRoot
  $FallbackNodeExecutable = $nodeExe
  $FallbackNodeDirectory = $nodeRoot
} catch {
  [Console]::Error.WriteLine('pi-review-sessions: isolated Node bootstrap failed: unsafe path or download/validation failure.')
  if (-not [string]::IsNullOrEmpty($script:NodeGenerationMarker)) {
    try { [IO.File]::Delete($script:NodeGenerationMarker) } catch { }
  }
  # A failed preparation keeps this launch's own incomplete witness, exactly like
  # the POSIX producer: its in-progress marker is already gone, so it is an
  # ordinary disposable generation that a later pass reclaims. Reclaiming it here
  # instead would make every failed preparation silently shrink the cache, so a
  # cache still within its per-type target would lose real capacity on each
  # transient failure. The witness never becomes the kept generation: the runtime
  # the pointer still names stays reusable, and settlement preserves the marked
  # generation instead of preferring the failed one -- otherwise reclamation could
  # delete the code the pointer names and force an unnecessary reinstall after a
  # transient failure.
  $settleKeep = $keepPath
  if ($null -ne $WorkRoot -and -not [string]::IsNullOrEmpty($WorkRoot)) {
    [Console]::Error.WriteLine('pi-review-sessions: retained bootstrap witness: ' + $WorkRoot)
  }
  # Settlement retry after a failed preparation, joined before exiting.
  if (-not [string]::IsNullOrEmpty($agentDirectory) -and -not [string]::IsNullOrEmpty($cacheRoot)) {
    Invoke-NodeSettlementCleanup $cacheRoot $agentDirectory $settleKeep
  }
  exit 1
}
# Start-SessionCjs exits the process, so release the in-progress marker in a
# finally block that still runs on `exit`.
try {
  Start-SessionCjs $FallbackNodeExecutable $FallbackNodeDirectory $CjsArguments
} finally {
  if (-not [string]::IsNullOrEmpty($script:NodeGenerationMarker)) {
    try { [IO.File]::Delete($script:NodeGenerationMarker) } catch { }
  }
  # Settlement retry: cleanup that contention deferred during preparation is
  # retried once here, joined, preserving this launch's own generation.
  if (-not [string]::IsNullOrEmpty($agentDirectory) -and -not [string]::IsNullOrEmpty($cacheRoot)) {
    Invoke-NodeSettlementCleanup $cacheRoot $agentDirectory $WorkRoot
  }
}
