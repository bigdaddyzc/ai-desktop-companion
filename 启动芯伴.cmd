@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem Some IDE / debug shells export ELECTRON_RUN_AS_NODE, which makes Electron run
rem as plain Node and crash before any window opens.
set ELECTRON_RUN_AS_NODE=

set "ELECTRON_EXE=%~dp0node_modules\electron\dist\electron.exe"

rem A quoted path ending with a backslash escapes the closing quote on Windows,
rem so strip it before handing the app directory to Electron.
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"

if not exist "%ELECTRON_EXE%" (
  echo [!] Electron is not installed. Running npm install...
  call npm install
  if errorlevel 1 (
    echo [X] npm install failed.
    pause
    exit /b 1
  )
)

if not exist "dist\desktop\main.cjs" (
  echo [!] No build found, building first...
  call npm run build
  if errorlevel 1 (
    echo [X] Build failed.
    pause
    exit /b 1
  )
)

start "" "%ELECTRON_EXE%" "%APP_DIR%"
exit /b 0
