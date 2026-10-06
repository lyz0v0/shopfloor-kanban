@echo off
setlocal
title Install Kanban TV autostart

rem ==========================================================
rem  Makes the kanban board open automatically after Windows
rem  starts - for the PC that is plugged into the TV.
rem
rem  To remove autostart later, just delete the copied file
rem  from the Startup folder shown below.
rem ==========================================================

set "SRC=%~dp0start-kanban-tv.bat"
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\kanban-tv.bat"

if not exist "%SRC%" (
  echo [FAIL] start-kanban-tv.bat was not found next to this script.
  echo [FAIL] Keep both files in the same folder.
  echo.
  pause
  exit /b 1
)

copy /y "%SRC%" "%DST%" >nul
if errorlevel 1 (
  echo [FAIL] Could not write into the Startup folder.
) else (
  echo [OK] Autostart installed.
  echo [OK] File: %DST%
  echo.
  echo The board will now open on its own after Windows starts.
  echo To undo this, delete that file.
)
echo.
pause
