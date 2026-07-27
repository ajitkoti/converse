@echo off
REM Double-click this file on Windows to run Converse from source.
REM (Requires Node.js - https://nodejs.org - LTS. For a no-Node install, download
REM  the .exe from Releases instead; see INSTALL.md.)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS from https://nodejs.org, then double-click again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install || ( echo npm install failed. & pause & exit /b 1 )
)

start "" "http://localhost:5173"
echo Starting Converse - the app will open in your browser. Close this window to stop.
call npm start
pause
