@echo off
setlocal DisableDelayedExpansion
rem Native Windows one-command session-host entry point. The PowerShell
rem bootstrap selects supported PATH Node or verifies/extracts the fixed
rem official Node 22.19.0 archive before invoking the shared CJS unchanged.

rem Capability isolation must precede the PowerShell child, every Node probe,
rem and every bootstrap network/archive child. Never remove role/catalog
rem markers to make a real setup authorized.
rem Diagnostics inside these blocks escape every parenthesis with a caret;
rem an unescaped parenthesis would end the block early and abort the launcher.
if defined PI_REVIEW_GATE_RUNTIME_ROLE (
  echo pi-review-sessions: unsupported role context ^(PI_REVIEW_GATE_RUNTIME_ROLE^).
  exit /b 1
)
if defined PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG (
  echo pi-review-sessions: unsupported role context ^(PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG^).
  exit /b 1
)
set "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP="
set "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE="

if not exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" (
  echo pi-review-sessions: Windows PowerShell is required for the isolated Node bootstrap.
  exit /b 1
)

rem Delayed expansion stays disabled so ! and quoted spaces are not rewritten.
rem Forward the original argument tail once for PowerShell's script arguments;
rem do not join it into a second PowerShell -Command expression.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0pi-review-sessions-node.ps1" %*
exit /b %ERRORLEVEL%
