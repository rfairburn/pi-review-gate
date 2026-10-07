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
  assert.match(code, /'\.terraform'/);
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
  const terraformCheck = validator.indexOf("'.terraform'");
  const normalize = validator.indexOf("[System.IO.Path]::GetFullPath($Candidate)");
  const filesystemAccess = validator.indexOf("[System.IO.File]::GetAttributes(");

  assert.ok(validator.includes(String.raw`$isDriveAbsolute = $Candidate -match '\A[A-Za-z]:[\\/]'`));
  assert.ok(validator.includes(String.raw`$isUncAbsolute = $Candidate -match '\A\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)'`));
  assert.match(validator, /if \(-not \(\$isDriveAbsolute -or \$isUncAbsolute\) -or\s+-not \[System\.IO\.Path\]::IsPathRooted\(\$Candidate\)\)/);
  assert.ok(deviceGuard >= 0 && driveCheck > deviceGuard && uncCheck > driveCheck);
  assert.ok(terraformCheck >= 0 && terraformCheck < normalize);
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
