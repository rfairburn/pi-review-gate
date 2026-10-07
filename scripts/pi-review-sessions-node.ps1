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

# Capture the Windows volume serial and file index from an open handle. Add-Type
# may use the process temp path while compiling, so compile only inside this
# owned workspace and restore the user's original temp environment immediately.
function Initialize-IdentityType([string]$TemporaryDirectory) {
  $tempWasSet = Test-Path Env:TEMP
  $tmpWasSet = Test-Path Env:TMP
  $originalTemp = $env:TEMP
  $originalTmp = $env:TMP
  try {
    $env:TEMP = $TemporaryDirectory
    $env:TMP = $TemporaryDirectory
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PiReviewGateNodeIdentity {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInformation {
    public uint Attributes;
    public FileTime CreationTime;
    public FileTime LastAccessTime;
    public FileTime LastWriteTime;
    public uint VolumeSerialNumber;
    public uint SizeHigh;
    public uint SizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
  public static string Read(string path) {
    using (SafeFileHandle handle = CreateFile(path, 0x80, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      FileInformation information;
      if (!GetFileInformationByHandle(handle, out information)) throw new Win32Exception(Marshal.GetLastWin32Error());
      return information.VolumeSerialNumber.ToString("x8") + ":" + information.FileIndexHigh.ToString("x8") + information.FileIndexLow.ToString("x8");
    }
  }
}
'@
  } finally {
    if ($tempWasSet) { $env:TEMP = $originalTemp } else { Remove-Item Env:TEMP -ErrorAction SilentlyContinue }
    if ($tmpWasSet) { $env:TMP = $originalTmp } else { Remove-Item Env:TMP -ErrorAction SilentlyContinue }
  }
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
  return [PiReviewGateNodeIdentity]::Read($Path)
}

function Assert-PathIdentity([string]$Path, [string]$Expected) {
  return (Get-PathIdentity $Path) -ceq $Expected
}

# Create path components one at a time and reject reparse points. This does not
# claim protection against a malicious same-user process racing filesystem ops.
function Ensure-DirectoryTree([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
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

$WorkRoot = $null
try {
  $agentDirectory = Get-AgentDirectory
  $cacheRoot = Ensure-DirectoryTree (Join-Path (Join-Path $agentDirectory '.pi-review-gate') 'node')
  $candidateWorkRoot = Join-Path $cacheRoot ('bootstrap-' + [Guid]::NewGuid().ToString('N'))
  New-ExclusiveDirectory $candidateWorkRoot
  if ([IO.Directory]::GetFileSystemEntries($candidateWorkRoot).Length -ne 0) { throw 'Exclusive bootstrap workspace was not empty.' }
  $WorkRoot = $candidateWorkRoot
  Initialize-IdentityType $WorkRoot | Out-Null
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
  [Console]::Error.WriteLine('pi-review-sessions: isolated Node bootstrap failed; no existing runtime or cache resource was changed.')
  if ($null -ne $WorkRoot) {
    [Console]::Error.WriteLine('pi-review-sessions: retained bootstrap witness: ' + $WorkRoot)
  }
  exit 1
}
Start-SessionCjs $FallbackNodeExecutable $FallbackNodeDirectory $CjsArguments
