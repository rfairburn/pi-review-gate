@echo off
setlocal
rem Native Windows entry point for the persistent pi-review-gate launcher
rem (issue 108). macOS/Linux keep scripts/pi-review-gate.sh; this file and its
rem Node helper (scripts/pi-review-gate-launcher.cjs) mirror that launcher for
rem cmd.exe and PowerShell without Bash, WSL, or PowerShell script execution.
rem
rem Requires Node.js 20+ on PATH. The helper dispatches Pi management verbs
rem without setup (keeping the inherited environment and pi's exit status) and
rem invokes pi for normal launches without an additional shell parsing pass,
rem so forwarded arguments arrive byte-exact. The batch layer is deliberately
rem thin: a single raw `%*` passthrough, nothing re-quoted.
node "%~dp0pi-review-gate-launcher.cjs" %*
exit /b %ERRORLEVEL%