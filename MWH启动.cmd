@echo off
setlocal
rem MWH launcher: three-layer silent self-healing, daemon preflight, then open the desktop shell.
rem Preflight failure no longer blocks the window; the chrome banner shows the real host status.
rem Exit MWH via the tray icon (MWH logo) -> Quit.

set "ELECTRON_RUN_AS_NODE="
set "ROOT=%~dp0"
set "ELECTRON_EXE=%ROOT%shell\node_modules\electron\dist\electron.exe"

rem 0. Locate node.exe dynamically and prepend its directory to local PATH to bypass broken npm shims.
set "NODE_EXE="
for /f "delims=" %%I in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%I"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  echo [ERROR] node.exe not found. Please install Node.js 22+ first.
  pause
  exit /b 1
)
for %%I in ("%NODE_EXE%") do set "PATH=%%~dpI;%PATH%"

rem 1. Three-layer silent self-healing (shell electron, backend cli, frontend ui).
"%NODE_EXE%" "%ROOT%scripts\ensure-ready.mjs"
if errorlevel 1 (
  echo [ERROR] MWH auto-heal/build failed. Window NOT opened.
  pause
  exit /b 1
)

if not exist "%ELECTRON_EXE%" (
  echo [ERROR] electron.exe still missing after self-heal:
  echo %ELECTRON_EXE%
  pause
  exit /b 1
)

echo [INFO] starting host daemon and waiting for 127.0.0.1:19820 ...
pushd "%ROOT%shell"
"%ELECTRON_EXE%" . --ensure-daemon-only
set "PREFLIGHT_EXIT=%errorlevel%"
popd

if not "%PREFLIGHT_EXIT%"=="0" (
  echo.
  echo [WARN] daemon preflight failed ^(exit %PREFLIGHT_EXIT%^). Opening the shell anyway.
  echo         The chrome banner will show the real host status.
)

rem Never leak the preflight-only flag into the shell process.
set "ELECTRON_RUN_AS_NODE="
start "MWH" /D "%ROOT%shell" "%ELECTRON_EXE%" .
echo MWH shell launched detached. Use the tray icon (MWH logo) to Quit.
ping 127.0.0.1 -n 2 >nul
endlocal
