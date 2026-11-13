import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * These are synthetic source-contract checks only. They intentionally do not
 * execute PowerShell, spawn a native process, invoke node-pty, or prove Windows
 * kernel/native/Main/terminal-restoration behavior. A Windows integration
 * harness must run separately and combine this observer with its own public
 * child-ownership, graceful-shutdown, PTY, journal, and restoration evidence.
 */
const fixturePath = join(process.cwd(), "tests", "fixtures", "session-host-windows-exit-watcher.ps1");
const source = readFileSync(fixturePath, "utf8");
const code = source.replace(/<#[\s\S]*?#>/g, "").replace(/^[ \t]*#.*$/gm, "");

test("Windows exit-watcher source contract: bounded exact-PID interface", () => {
  assert.match(source, /Windows PowerShell 5\.1\s*\/\s*\.NET Framework 4\.8 public-API fixture/);
  assert.match(source, /\[string\] \$Root/);
  assert.match(source, /\[int\] \$NativePid/);
  assert.match(source, /\[string\] \$RequestNonce/);
  assert.match(source, /\[ValidateRange\(1, 480\)\]/);
  assert.match(source, /\[int\] \$TimeoutSeconds = 480/);
  assert.match(source, /\$NativePid -lt 2/);
  assert.match(source, /\\A\[A-Za-z0-9_-\]\{16,128\}\\z/);
  assert.match(source, /Root must be a fully qualified drive path or complete UNC server\/share path/);
  assert.match(source, /drive-relative and current-drive-relative paths are rejected/);
  assert.match(source, /ExpectedStartTimeUtcTicks/);
  assert.match(code, /\$hasExpectedStartTime = \$PSBoundParameters\.ContainsKey\('ExpectedStartTimeUtcTicks'\)/);
  assert.match(code, /if \(\$hasExpectedStartTime\) \{/);
  assert.match(code, /if \(\$hasExpectedStartTime -and \$creationTimeUtc\.Ticks -ne \$expectedTicks\)/);
  assert.doesNotMatch(code, /\$ExpectedStartTimeUtcTicks -ne \$null/);
  assert.match(code, /\$ExpectedStartTimeUtcTicks -notmatch '\\A\[0-9\]\{1,19\}\\z'/);
  assert.match(source, /NumberStyles\]::None/);
  assert.match(source, /CultureInfo\]::InvariantCulture/);
});

test("Windows exit-watcher source contract: retain and wait on the same public process handle", () => {
  const lookup = code.indexOf("[System.Diagnostics.Process]::GetProcessById($NativePid)");
  const handle = code.indexOf("$heldProcessHandle = $process.Handle");
  const startTime = code.indexOf("$process.StartTime.ToUniversalTime()");
  const initialHasExited = code.indexOf("if ($process.HasExited)");
  const preReadyHasExited = code.indexOf("if ($process.HasExited)", startTime);
  const ready = code.indexOf("-State 'READY'");
  const wait = code.indexOf("$process.WaitForExit($remainingMilliseconds)");
  const hasExited = code.indexOf("if ($process.HasExited)", wait);
  const exitCode = code.indexOf("$process.ExitCode", wait);

  assert.ok(lookup >= 0 && handle > lookup, "exact PID lookup precedes public handle acquisition");
  assert.ok(handle > lookup && initialHasExited > handle && startTime > initialHasExited, "lookup, handle acquisition, and initial live check precede creation time");
  assert.ok(preReadyHasExited > startTime && ready > preReadyHasExited, "a second live check precedes READY");
  assert.equal((code.match(/::GetProcessById\(/g) ?? []).length, 1, "never reacquire the PID after handle binding");
  assert.match(code, /\$creationTimeUtc\.Ticks -ne \$expectedTicks/);
  assert.ok(wait > ready && hasExited > wait && exitCode > hasExited, "bounded wait and exit code use the retained process object");
  assert.match(code, /\$process\.WaitForExit\(\$remainingMilliseconds\)/);
  assert.match(code, /\$process\.HasExited/);
  assert.match(code, /\$process\.ExitCode/);
  assert.match(source, /Process\.Handle: https:\/\/learn\.microsoft\.com\/dotnet\/api\/system\.diagnostics\.process\.handle\?/);
  assert.match(source, /Process\.WaitForExit\(Int32\): https:\/\/learn\.microsoft\.com\/dotnet\/api\/system\.diagnostics\.process\.waitforexit\?/);
  assert.match(source, /Process\.StartTime: https:\/\/learn\.microsoft\.com\/dotnet\/api\/system\.diagnostics\.process\.starttime\?/);
});

test("Windows exit-watcher source contract: fail-closed states and exact witness schema", () => {
  assert.match(code, /schemaVersion = 1/);
  assert.match(code, /requestNonce = \$Nonce/);
  assert.match(code, /observerPid = \$ObserverProcessId/);
  assert.match(code, /nativePid = \$NativeProcessId/);
  assert.match(code, /nativeCreationTimeUtcTicks = \$CreationTicks/);
  assert.ok(code.includes(String.raw`[AllowNull()][object] $CreationTicks`));
  assert.doesNotMatch(code, /\[AllowNull\(\)\]\[string\] \$CreationTicks/);
  assert.match(code, /\$creationTicks = \$null/);
  assert.match(code, /\$payload\.exitCode = \[int\] \$ObservedExitCode/);
  assert.match(code, /if \(\$State -eq 'exited'\)/);
  assert.match(code, /\$terminalState = 'unavailable'/);
  assert.match(code, /\$terminalState = 'timed-out'/);
  assert.match(code, /\$terminalState = 'failure'/);
  assert.match(code, /\$scriptExitCode = 2/);
  assert.match(code, /\$resultPublished -and \$terminalState -eq 'exited'/);
  assert.match(source, /nativeCreationTimeUtcTicks/);
  assert.match(source, /result uses exited, unavailable, timed-out,\s*or failure, with exitCode present only for exited/);
  assert.match(code, /-State 'READY'/);
  assert.match(source, /16-128 safe ASCII characters/);
  assert.match(source, /Observer exit code 0 means only that an exited result was published/);
  assert.match(source, /native process's actual code is the separate result\.exitCode field/);
  assert.match(source, /A READY witness alone\s*\n\s*is not proof of ownership/);
});

test("Windows exit-watcher source contract: exclusive root-bound publication only", () => {
  assert.match(code, /Get-ValidatedRootPath/);
  assert.match(code, /IsPathRooted\(\$Candidate\)/);
  assert.match(code, /FileAttributes\]::ReparsePoint/);
  assert.match(code, /\$RequestNonce \+ '\.ready\.json'/);
  assert.match(code, /\$RequestNonce \+ '\.result\.json'/);
  assert.match(code, /FileMode\]::CreateNew/);
  assert.match(code, /FileShare\]::None/);
  assert.match(code, /Witness collision\./);
  assert.match(source, /Both are CreateNew-only/);
  assert.match(source, /same-user filesystem races/i);
  assert.match(source, /No Windows ACL-equivalence claim/);
  assert.match(source, /parent must validate its BigInt root\s+identity before and after/);
  assert.match(source, /DirectoryInfo\.FullName or timestamps/);
  assert.match(code, /\$bytes\.Length -gt 1024/);
  assert.doesNotMatch(code, /Directory\]::CreateDirectory|File\]::Delete|Directory\]::Delete|Move-Item|Copy-Item|Remove-Item/);
});

test("Windows exit-watcher source contract: root is fully qualified before normalization or filesystem access", () => {
  const validatorStart = code.indexOf("function Get-ValidatedRootPath");
  const validatorEnd = code.indexOf("function New-WitnessPayload", validatorStart);
  const validator = code.slice(validatorStart, validatorEnd);
  const deviceGuard = validator.indexOf("$Candidate.StartsWith(");
  const driveCheck = validator.indexOf("$isDriveAbsolute = $Candidate -match");
  const uncCheck = validator.indexOf("$isUncAbsolute = $Candidate -match");
  const normalize = validator.indexOf("[System.IO.Path]::GetFullPath($Candidate)");
  const filesystemAccess = validator.indexOf("[System.IO.File]::GetAttributes(");

  assert.ok(validator.includes(String.raw`$isDriveAbsolute = $Candidate -match '\A[A-Za-z]:[\\/]'`));
  assert.ok(validator.includes(String.raw`$isUncAbsolute = $Candidate -match '\A\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'`));
  assert.match(validator, /if \(-not \(\$isDriveAbsolute -or \$isUncAbsolute\) -or\s+-not \[System\.IO\.Path\]::IsPathRooted\(\$Candidate\)\)/);
  assert.ok(deviceGuard >= 0 && driveCheck > deviceGuard && uncCheck > driveCheck);
  assert.ok(normalize > uncCheck && filesystemAccess > normalize, "reject relative/device paths before canonicalization or descent");
});

test("Windows exit-watcher source contract: no process control, scans, or private native helpers", () => {
  assert.doesNotMatch(code, /\b(?:Get-Process|GetProcesses|GetProcessesByName|Get-CimInstance|Get-WmiObject|Start-Process|taskkill|Add-Type|DllImport|OpenProcess|CreateProcess|TerminateProcess)\b/i);
  assert.doesNotMatch(code, /\.\s*Kill\s*\(/i);
  assert.doesNotMatch(code, /NamedPipe|ACL|Set-Acl|RoleAuth|session[_-]shutdown|transcript/i);
  assert.doesNotMatch(code, /\$env:|ProcessStartInfo|Write-Host|Write-Output/i);
  assert.match(source, /node-pty exit\/signal semantics/);
  assert.match(source, /public native session_shutdown\/quit receipt/);
  assert.match(source, /Main\/outer exit codes/);
  assert.match(source, /terminal restoration/);
});

test("Windows exit-watcher source contract: stderr-only stage markers instrument the same observation without changing it", () => {
  // One guarded helper, one emission point, STDERR only, and a fixed vocabulary.
  const helperStart = code.indexOf("function Write-ObserverStageMarker");
  const helperEnd = code.indexOf("function Get-ValidatedRootPath", helperStart);
  const helper = code.slice(helperStart, helperEnd);
  assert.ok(helperStart > 0 && helperEnd > helperStart, "one marker helper is defined before its first use");
  assert.match(helper, /\[System\.Console\]::Error\.WriteLine\('PRG-OBS-STAGE:' \+ \$Stage\)/);
  assert.equal((code.match(/PRG-OBS-STAGE:/g) ?? []).length, 1, "one fixed emission point for every stage marker");
  assert.doesNotMatch(helper, /\[System\.Console\]::Out|Write-Output|Write-Host|Start-Sleep|Thread/);
  assert.doesNotMatch(helper, /\$Root|\$RequestNonce|\$NativePid|\$process\b|\$observerPid/,
    "a marker carries the stage name and never a path, nonce, PID, or error text");

  // One call site per stage, placed around the unchanged observation steps.
  const entered = code.indexOf("Write-ObserverStageMarker -Stage 'script-entered'");
  const rootValidated = code.indexOf("Write-ObserverStageMarker -Stage 'root-validated'");
  const lookupStart = code.indexOf("Write-ObserverStageMarker -Stage 'lookup-start'");
  const handleBound = code.indexOf("Write-ObserverStageMarker -Stage 'handle-bound'");
  const readyPublished = code.indexOf("Write-ObserverStageMarker -Stage 'ready-published'");
  const resultPublished = code.indexOf("Write-ObserverStageMarker -Stage 'result-published'");
  const bodyStart = code.indexOf("if ([System.Environment]::OSVersion.Platform");
  const rootCall = code.indexOf("$rootPath = Get-ValidatedRootPath -Candidate $Root");
  const lookup = code.indexOf("[System.Diagnostics.Process]::GetProcessById($NativePid)");
  const handle = code.indexOf("$heldProcessHandle = $process.Handle");
  const readyWrite = code.indexOf("$readyPublished = $true");
  const resultWrite = code.indexOf("$resultPublished = $true");

  assert.equal((code.match(/Write-ObserverStageMarker -Stage '/g) ?? []).length, 6, "exactly six stage call sites");
  for (const [name, index] of Object.entries({ entered, rootValidated, lookupStart, handleBound, readyPublished, resultPublished })) {
    assert.ok(index >= 0, `${name} marker exists`);
  }
  assert.ok(entered < bodyStart, "script-entered precedes the observation body itself");
  assert.ok(rootValidated > rootCall && rootValidated < lookupStart, "root-validated follows validation and precedes the lookup");
  assert.ok(lookupStart < lookup && lookup < handleBound, "lookup-start precedes the exact-PID lookup, handle-bound follows it");
  assert.ok(readyPublished > readyWrite, "ready-published follows the completed READY publication");
  assert.ok(resultPublished > resultWrite, "result-published follows the completed result publication");

  // Diagnosis only: the markers never enter the witness schema, its states, or a
  // wait, and they never add a timer, retry, or deadline to the observation.
  const payload = code.slice(code.indexOf("function New-WitnessPayload"), code.indexOf("function Write-WitnessExclusive"));
  assert.doesNotMatch(payload, /PRG-OBS-STAGE|Write-ObserverStageMarker/, "no marker text can reach a witness payload");
  assert.doesNotMatch(code, /terminalState\s*=\s*'PRG|PRG-OBS-STAGE[^\n]*terminalState/, "a marker is never a state");
  assert.doesNotMatch(code, /Start-Sleep|System\.Threading\.(?:Timer|Thread)|while \(\$/, "no new wait or retry loop");
  assert.equal((code.match(/Stopwatch\]::StartNew\(\)/g) ?? []).length, 1, "the one existing bounded wait stopwatch is unchanged");
  assert.match(code, /\$process\.WaitForExit\(\$remainingMilliseconds\)/);
  assert.match(code, /\[int\] \$TimeoutSeconds = 480/);

  // STDOUT stays exactly as untouched as before: the only console writes are STDERR.
  assert.doesNotMatch(code, /\[System\.Console\]::(Out|Write(?!Line))/i);
  assert.doesNotMatch(code, /Write-Information|Write-Verbose|Write-Debug|Out-File|Tee-Object|Start-Transcript/i);
});

test("Windows exit-watcher source contract: witness JSON is serialized only by the pinned built-in module", () => {
  // One owned prerequisite function, defined before use, whose only module lookup is
  // an absolute path inside the running host's own installation directory.
  const pinStart = code.indexOf("function Initialize-BuiltInJsonSerializer");
  const pinEnd = code.indexOf("function Write-ObserverStageMarker", pinStart);
  assert.ok(pinStart >= 0 && pinEnd > pinStart, "the serializer pin is one function defined before its use");
  const pin = code.slice(pinStart, pinEnd);

  // $PSHOME is the automatic variable of the running host process: reading it
  // resolves no command, and the path is built with the .NET Path.Combine rather
  // than another command that could itself start module discovery.
  assert.match(pin, /\[string\]::IsNullOrWhiteSpace\(\$PSHOME\)/);
  assert.match(pin, /\$builtInManifest = \[System\.IO\.Path\]::Combine\(\s*\$PSHOME,\s*'Modules',\s*'Microsoft\.PowerShell\.Utility',\s*'Microsoft\.PowerShell\.Utility\.psd1'\s*\)/);
  assert.doesNotMatch(pin, /\$Root|\$env:/, "the pin never depends on the caller's root or an environment value");

  // The built-in module is imported by that absolute path only, and its absence is a
  // clear failure: no ambient module name is ever resolved.
  assert.equal((code.match(/\bImport-Module\b/g) ?? []).length, 1, "one Import-Module: the absolute built-in pin");
  assert.match(pin, /Import-Module -Name \$builtInManifest -ErrorAction Stop/);
  assert.match(pin, /if \(-not \[System\.IO\.File\]::Exists\(\$builtInManifest\)\)/);
  assert.match(pin, /throw 'Built-in serialization module is missing\.'/);
  assert.match(pin, /throw 'Built-in serialization module could not be loaded\.'/);
  assert.equal((code.match(/Get-Module -Name 'Microsoft\.PowerShell\.Utility'/g) ?? []).length, 2,
    "only loaded-module lookups, which never search a module path");

  // No ambient discovery or module-path surface anywhere: not a name-based import,
  // not a list/find/install call, not the module-path variable, not a Join-Path.
  assert.doesNotMatch(code, /-ListAvailable|\bGet-Command\b|Find-Module|Save-Module|Install-Module|Uninstall-Module|Import-PSSession|PSModulePath|ModuleAutoLoading|\bJoin-Path\b/);

  // Negative controls for the trust decision itself. The guard has exactly two
  // rejection arms and neither accepts an unverifiable module: a dynamically created
  // same-named module (New-Module -Name Microsoft.PowerShell.Utility) carries an
  // empty Path, and an ambient same-named module (for example a PowerShell 7 build
  // from another module path) carries a Path outside $PSHOME. Both throw while the
  // pin still runs before $canPublish, so such a host terminates nonzero with no
  // witness leaf at all instead of serializing through the decoy.
  assert.match(pin, /\$loadedModulePath = \[string\] \$loadedSerializerModule\.Path/);
  assert.match(pin, /if \(\[string\]::IsNullOrEmpty\(\$loadedModulePath\)\)\s*\{\s*throw 'Loaded serialization module has no filesystem identity\.'/);
  assert.match(pin, /if \(-not \$loadedModulePath\.StartsWith\(\$PSHOME \+ \[System\.IO\.Path\]::DirectorySeparatorChar, \[System\.StringComparison\]::OrdinalIgnoreCase\)\)\s*\{\s*throw 'Loaded serialization module is not the built-in one\.'/);
  assert.equal((pin.match(/throw 'Loaded serialization module/g) ?? []).length, 2,
    "both an empty module path and an outside-$PSHOME module path are rejected");
  assert.doesNotMatch(pin, /-not \[string\]::IsNullOrEmpty\(\$loadedModulePath\)\s*-and/,
    "an empty module path is never accepted as built-in");
  assert.doesNotMatch(pin, /if \(\$loadedModulePath\)|if \(\$loadedSerializerModule\.Path\)/,
    "a module path is never trusted without an explicit emptiness test");

  // Every serializer use is qualified to that pinned module, so no unqualified name
  // can start discovery inside the publication path, and the payload shape, the
  // compression, and the depth are the ones the witness schema already requires.
  assert.equal((code.match(/ConvertTo-Json/g) ?? []).length, 1, "one serializer call site");
  assert.equal((source.match(/(?<!\\)ConvertTo-Json/g) ?? []).length, 0, "every ConvertTo-Json is module-qualified");
  assert.match(code, /Microsoft\.PowerShell\.Utility\\ConvertTo-Json -InputObject \$Payload -Compress -Depth 4/);

  // The pin runs as a prerequisite, before anything can be published, so a host
  // without the built-in serializer exits nonzero with no witness at all.
  assert.equal((code.match(/^ {4}Initialize-BuiltInJsonSerializer$/gm) ?? []).length, 1, "one pin call site");
  const pinCall = code.indexOf("    Initialize-BuiltInJsonSerializer");
  const canPublish = code.indexOf("$canPublish = $true");
  const firstPublication = code.indexOf("Write-WitnessExclusive -OriginalRoot");
  assert.ok(pinCall >= 0 && pinCall < canPublish && canPublish < firstPublication,
    "a missing built-in serializer publishes no witness, not even a failure one");

  // Fail closed, and nothing else: no ignore, no retry, no wait, no substitute
  // serializer, and no stage marker or readiness claim for the pin itself.
  assert.doesNotMatch(pin, /SilentlyContinue|ErrorAction\s+Ignore/, "the pin never ignores its own failure");
  assert.doesNotMatch(pin, /Start-Sleep|Stopwatch|Timer|\bfor \(|\bwhile \(/, "the pin never waits or retries");
  assert.doesNotMatch(pin, /Write-ObserverStageMarker|PRG-OBS-STAGE/, "the pin is not a stage marker and never a readiness signal");
  assert.equal((code.match(/Stopwatch\]::StartNew\(\)/g) ?? []).length, 1, "the one existing bounded wait stopwatch is unchanged");
  assert.match(code, /\$bytes\.Length -gt 1024/);
  assert.match(code, /FileMode\]::CreateNew/);
});
