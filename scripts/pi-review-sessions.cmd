@echo off
setlocal
rem One-command session host entry point for native Windows (issue 323),
rem paired with scripts/pi-review-sessions.sh on macOS/Linux. The alpha
rem session host itself supports POSIX only; on Windows the shared helper
rem reports that limitation before any setup runs. Backend parity
rem (transport, ConPTY, shutdown) is a later phase; this entry point alone
rem is not Windows host proof.
rem
rem Requires Node.js 22.19.0+ on PATH. The batch layer stays thin: it checks
rem the Node runtime with Node itself (no batch version arithmetic, so
rem pre-release floors behave exactly like the POSIX launcher) and then
rem delegates every argument to the shared setup/runtime selection helper.

rem Capability isolation before any probe child runs: executor role contexts
rem are rejected and the host bootstrap/restore authorization markers are
rem cleared, so the node -e check below (which inherits this environment,
rem including the user's own NODE_OPTIONS) never carries host authorization.
if defined PI_REVIEW_GATE_RUNTIME_ROLE (
  echo pi-review-sessions: unsupported role context (PI_REVIEW_GATE_RUNTIME_ROLE).
  exit /b 1
)
if defined PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG (
  echo pi-review-sessions: unsupported role context (PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG).
  exit /b 1
)
set "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP="
set "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE="

where node >nul 2>nul
if errorlevel 1 (
  echo pi-review-sessions: Node.js is required on PATH (install Node.js 22.19.0 or newer)
  exit /b 1
)

set "NODE_VERSION="
for /f "delims=" %%v in ('node --version') do set "NODE_VERSION=%%v"

node -e "const m=process.versions.node.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);if(!m){process.exit(1)}const a=[+m[1],+m[2],+m[3]];const min=[22,19,0];let ok=false;for(let i=0;i<3;i++){if(a[i]>min[i]){ok=true;break}if(a[i]<min[i])break}if(!ok&&a[0]===min[0]&&a[1]===min[1]&&a[2]===min[2]){ok=m[4]===undefined}process.exit(ok?0:1)"
if errorlevel 1 (
  echo pi-review-sessions: Node.js 22.19.0 or newer is required (found %NODE_VERSION%)
  exit /b 1
)

node "%~dp0pi-review-sessions.cjs" %*
exit /b %ERRORLEVEL%
