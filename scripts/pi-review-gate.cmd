@echo off
setlocal
rem Native Windows entry point for the persistent pi-review-gate launcher
rem (issue 108). macOS/Linux keep scripts/pi-review-gate.sh; this file and its
rem Node helper (scripts/pi-review-gate-launcher.cjs) mirror that launcher for
rem cmd.exe and PowerShell without Bash, WSL, or PowerShell script execution.
rem
rem Requires Node.js 22.19.0+ on PATH. The helper dispatches Pi management verbs
rem without setup (keeping the inherited environment and pi's exit status) and
rem invokes the resolved full pi.cmd path with quoted launch arguments.
rem Pi's shim contents are not inspected; normal batch parsing applies.
rem The batch layer stays thin: a single raw `%*` passthrough.
node "%~dp0pi-review-gate-launcher.cjs" %*
exit /b %ERRORLEVEL%
