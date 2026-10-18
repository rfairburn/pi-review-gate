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
$MinimumNode = [version]'22.19.0'

function Test-NodeFloor([string]$VersionText) {
  if ($VersionText -cnotmatch '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$') {
    return $false
  }
  try {
    $candidate = [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
  } catch {
    return $false
  }
  if ($candidate -lt $MinimumNode) { return $false }
  if ($candidate -eq $MinimumNode -and $Matches[4]) { return $false }
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
    $NodeArchive = 'node-v22.19.0-win-x64.zip'
    $NodeSha256 = 'ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86'
  }
  'ARM64' {
    $NodePlatform = 'win-arm64'
    $NodeArchive = 'node-v22.19.0-win-arm64.zip'
    $NodeSha256 = 'e4a7336010d58ff35b53d9dd5869095c56089c70913cf22508cf8183593e56b2'
  }
  'X86' {
    $NodePlatform = 'win-x86'
    $NodeArchive = 'node-v22.19.0-win-x86.zip'
    $NodeSha256 = '708b8a297a19e9ac433e32ac0fc496755757c5e00bd5a0683917e73cae5fe8ea'
  }
  default {
    [Console]::Error.WriteLine('pi-review-sessions: no pinned Node.js 22.19.0 archive is available for this Windows architecture.')
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
    @('CloseHandle', [bool], [Type[]]@([IntPtr]))
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
function Remove-NodeEntry([string]$Path, [int]$Depth) {
  # Bounded, no-follow removal of one designated cache generation. Reparse
  # points (symlinks/junctions) are unlinked themselves, never entered, so data
  # outside the generation is untouched. Cleanup-specific: even an initialized
  # `.terraform` subtree inside this disposable generation is removed.
  if ($Depth -gt 64) { return $false }
  $attributes = Get-ExistingAttributes $Path
  if ($null -eq $attributes) { return $true }
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    try {
      if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($Path, $false) }
      else { [IO.File]::Delete($Path) }
      return $true
    } catch { return $false }
  }
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
    try {
      foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($Path)) {
        if (-not (Remove-NodeEntry $child ($Depth + 1))) { return $false }
      }
      [IO.Directory]::Delete($Path, $false)
      return $true
    } catch { return $false }
  }
  try { [IO.File]::Delete($Path); return $true } catch { return $false }
}

function Test-NodeGenerationActive([string]$Path) {
  # True while a live producer owns this generation. Fence the generation root
  # first: a direct-child link/junction is not a generation and its outside
  # target must never be inspected. Invalid marker shapes are not liveness
  # evidence, and confined no-follow cleanup handles them.
  $rootAttributes = Get-ExistingAttributes $Path
  if ($null -eq $rootAttributes) { return $false }
  if (($rootAttributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  $marker = Join-Path $Path '.producer-active'
  $attributes = Get-ExistingAttributes $marker
  if ($null -eq $attributes) { return $false }
  if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
  try { $text = [IO.File]::ReadAllText($marker) } catch { return $false }
  if (Test-NodeLockOwner $text) { return $true }
  try { [IO.File]::Delete($marker) } catch { }
  return $false
}

function Test-NodeLockOwner([string]$Text) {
  if ($Text -match '^\s*(\d{1,10})\s*$') {
    try { $null = Get-Process -Id ([int]$Matches[1]) -ErrorAction Stop; return $true } catch { return $false }
  }
  return $false
}

function New-NodeGeneration([string]$Root, [string]$AgentDirectory) {
  $chain = Get-NodeFence $Root
  $lockPath = Join-Path $Root '.admission.lock'
  $lock = $null
  $lockIdentity = $null
  $skipCleanup = $false
  if (-not [string]::IsNullOrEmpty($AgentDirectory)) {
    # An existing session host owns this agent directory: its cache generations
    # are left alone, while startup still proceeds.
    $ownership = Join-Path (Join-Path $AgentDirectory 'session-host') 'host-ownership.json'
    if (Test-Path -LiteralPath $ownership) {
      $skipCleanup = $true
      [Console]::Error.WriteLine('pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.')
    }
  }
  try {
    Assert-NodeFence $chain
    # One short exclusive admission lock coordinates cleanup and creation. A
    # lock whose recorded owner is gone (or whose record is empty/malformed) is
    # reclaimed; a live owner is left alone and this producer then skips
    # cleanup. Capacity never refuses creation.
    $malformedLock = 0
    for ($attempt = 0; -not $skipCleanup -and $attempt -lt 40 -and $null -eq $lock; $attempt++) {
      try {
        $lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      } catch {
        try {
          $lockAttributes = Get-ExistingAttributes $lockPath
          if ($null -eq $lockAttributes
            -or ($lockAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
            -or ($lockAttributes -band [IO.FileAttributes]::Directory) -ne 0) { break }
          $lockText = [IO.File]::ReadAllText($lockPath)
          if ($lockText -match '^\s*(\d{1,10})\s*$') {
            $malformedLock = 0
            # A live owner is left alone; this producer then skips cleanup.
            if (Test-NodeLockOwner $lockText) { Start-Sleep -Milliseconds 50; continue }
          } else {
            # A just-created lock can be read before its pid is written; only a
            # record that stays empty/malformed is a dead owner's residue.
            $malformedLock++
            if ($malformedLock -lt 3) { Start-Sleep -Milliseconds 50; continue }
            $malformedLock = 0
          }
          [IO.File]::Delete($lockPath)
          continue
        } catch { break }
      }
    }
    if ($null -eq $lock -and -not $skipCleanup) {
      [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.')
    } elseif ($null -ne $lock) {
      # Best-effort cleanup only: every failure here warns and creation proceeds.
      try {
        $lockBytes = [Text.Encoding]::UTF8.GetBytes([string]$PID)
        $lock.Write($lockBytes, 0, $lockBytes.Length)
        $lock.Flush($true)
        $lockIdentity = Get-PathIdentity $lockPath
        Assert-NodeFence $chain
        $entries = @()
        try {
          $entries = @([IO.Directory]::EnumerateFileSystemEntries($Root))
        } catch {
          [Console]::Error.WriteLine('pi-review-sessions: Node cache inventory was unavailable; continuing without reclamation.')
        }
        $count = 0
        foreach ($entry in $entries) {
          if ([IO.Path]::GetFileName($entry) -cne '.admission.lock') { $count++ }
        }
        foreach ($entry in $entries) {
          if ($count -lt 5) { break }
          $name = [IO.Path]::GetFileName($entry)
          if ($name -ceq '.admission.lock' -or $name -ceq '.terraform') { continue }
          if (Test-NodeGenerationActive $entry) { continue }
          if (Remove-NodeEntry $entry 0) { $count-- }
        }
        if ($count -ge 5) {
          [Console]::Error.WriteLine("pi-review-sessions: Node cache still holds $count generations (target 5); continuing startup.")
        }
        Assert-NodeFence $chain
      } catch {
        [Console]::Error.WriteLine('pi-review-sessions: Node cache cleanup could not complete; continuing startup.')
      }
    }
    $candidate = Join-Path $Root ('bootstrap-' + [Guid]::NewGuid().ToString('N'))
    New-ExclusiveDirectory $candidate
    Assert-NodeFence $chain
    # The generation is disposable by location; no lifetime record is written.
    # A live owner marker keeps other producers from pruning it while the Node
    # archive is still being downloaded/extracted.
    $markerPath = Join-Path $candidate '.producer-active'
    $marker = [IO.File]::Open($markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try {
      $markerBytes = [Text.Encoding]::UTF8.GetBytes([string]$PID)
      $marker.Write($markerBytes, 0, $markerBytes.Length)
      $marker.Flush($true)
    } finally { $marker.Dispose() }
    return $candidate
  } finally {
    if ($null -ne $lock) {
      $lock.Dispose()
      try {
        Assert-NodeFence $chain
        if ($null -ne $lockIdentity -and (Assert-PathIdentity $lockPath $lockIdentity)) { [IO.File]::Delete($lockPath) }
      } catch { # Uncertain lock ownership is retained.
      }
    }
  }
}

$WorkRoot = $null
$script:NodeGenerationMarker = $null
try {
  $agentDirectory = Get-AgentDirectory
  $cacheRoot = Ensure-DirectoryTree (Join-Path (Join-Path $agentDirectory '.pi-review-gate') 'node')
  Initialize-IdentityType
  $script:BootstrapCacheFence = Get-NodeFence $cacheRoot
  $WorkRoot = New-NodeGeneration $cacheRoot $agentDirectory
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
  $url = 'https://nodejs.org/dist/v22.19.0/' + $NodeArchive
  Receive-OfficialArchive $url $archivePath
  Assert-OrdinaryFile $archivePath
  $archiveIdentity = Get-PathIdentity $archivePath
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $extractRoot $extractIdentity) -or -not (Assert-PathIdentity $archivePath $archiveIdentity)) { throw 'Bootstrap path identity changed after download.' }
  $actualSha256 = Get-Sha256 $archivePath
  if ($actualSha256 -cne $NodeSha256) { throw 'Official Node archive checksum mismatch.' }
  if (-not (Assert-PathIdentity $cacheRoot $cacheIdentity) -or -not (Assert-PathIdentity $WorkRoot $workIdentity) -or -not (Assert-PathIdentity $archivePath $archiveIdentity)) { throw 'Archive identity changed after checksum verification.' }

  $expectedRoot = 'node-v22.19.0-' + $NodePlatform
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
  $FallbackNodeExecutable = $nodeExe
  $FallbackNodeDirectory = $nodeRoot
} catch {
  [Console]::Error.WriteLine('pi-review-sessions: isolated Node bootstrap failed: unsafe path or download/validation failure.')
  if ($null -ne $WorkRoot) {
    [Console]::Error.WriteLine('pi-review-sessions: retained bootstrap witness: ' + $WorkRoot)
  }
  if (-not [string]::IsNullOrEmpty($script:NodeGenerationMarker)) {
    try { [IO.File]::Delete($script:NodeGenerationMarker) } catch { }
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
}
