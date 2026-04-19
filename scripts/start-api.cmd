@echo off
REM Double-click or run from cmd: starts Zarewa API on port 8787 (default).
cd /d "%~dp0.."
echo.
echo Zarewa API — http://localhost:8787
echo If you see "EADDRINUSE", port 8787 is already taken. Close the other terminal or run stop-api-8787.cmd first.
echo.
node server/index.js
echo.
pause
