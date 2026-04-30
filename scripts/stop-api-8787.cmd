@echo off
REM Stops whatever process is listening on TCP port 8787 (Zarewa API).
cd /d "%~dp0.."
echo Finding process on port 8787...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  echo Stopping PID %%a
  taskkill /PID %%a /F 2>nul
)
echo Done.
pause
