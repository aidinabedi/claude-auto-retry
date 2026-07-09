@echo off
rem claude-auto-retry launcher for Windows.
rem Runs the CLI straight from this repo (no global install / npm link needed) and
rem forwards every argument to bin/cli.js, then propagates its exit code.
rem   claude-auto-retry.cmd                 -> interactive claude
rem   claude-auto-retry.cmd --model opus    -> claude --model opus
rem   claude-auto-retry.cmd version         -> print version
rem %~dp0 is this file's own folder (with trailing \), so cwd doesn't matter.
node "%~dp0bin\cli.js" %*
exit /b %errorlevel%
