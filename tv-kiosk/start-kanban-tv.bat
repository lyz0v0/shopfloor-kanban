@echo off
setlocal
title Kanban TV Screen

rem ==========================================================
rem  Kanban board launcher for TV screens
rem
rem  Usage:  start-kanban-tv.bat           show ALL orders
rem          start-kanban-tv.bat 小张      show only this owner
rem
rem  Full screen (kiosk) mode. Press Alt+F4 to exit.
rem  If you prefer F11-style full screen instead, replace
rem  --kiosk with --start-fullscreen below.
rem ==========================================================

set "URL=https://gongdan-kanban-10845.app.workbuddy.host/kanban.html"
if not "%~1"=="" set "URL=%URL%?owner=%~1"

set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do (
  if not defined BROWSER if exist %%P set "BROWSER=%%~P"
)

if not defined BROWSER (
  echo [WARN] Chrome or Edge not found.
  echo [WARN] Opening with the default browser - press F11 for full screen.
  start "" "%URL%"
  exit /b 1
)

echo [OK] Browser : %BROWSER%
echo [OK] URL     : %URL%
echo.
echo [OK] Launching in full screen. Press Alt+F4 to exit.

start "" "%BROWSER%" --kiosk "%URL%" --user-data-dir="%LOCALAPPDATA%\KanbanTV" --no-first-run --no-default-browser-check --disable-session-crashed-bubble --disable-infobars --disable-features=Translate,MediaRouter --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-pinch --overscroll-history-navigation=0 --autoplay-policy=no-user-gesture-required

exit /b 0
