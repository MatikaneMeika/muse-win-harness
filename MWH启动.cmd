@echo off
setlocal
rem MWH launcher: verify the host daemon FIRST, then open the desktop shell.
rem If the daemon cannot be started and authenticated, no window is opened at all.
rem Exit MWH via the tray icon (MWH logo) -> Quit.

set "ROOT=%~dp0"
set "ELECTRON_EXE=%ROOT%shell\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON_EXE%" (
  echo [ERROR] electron.exe not found:
  echo %ELECTRON_EXE%
  echo Run "npm --prefix shell install" first.
  pause
  exit /b 1
)

if not exist "%ROOT%dist\cli.js" (
  echo [INFO] dist\cli.js not found, building backend first...
  call npm --prefix "%ROOT%." run build
  if errorlevel 1 (
    rem npm can be broken on some machines (missing shim); fall back to tsc directly.
    echo [WARN] "npm run build" failed, retrying with local typescript...
    node "%ROOT%node_modules\typescript\bin\tsc" -p "%ROOT%tsconfig.json"
    if errorlevel 1 (
      echo [ERROR] backend build failed. Window NOT opened.
      pause
      exit /b 1
    )
  )
)

echo [INFO] starting host daemon and waiting for 127.0.0.1:19820 ...
pushd "%ROOT%shell"
"%ELECTRON_EXE%" . --ensure-daemon-only
set "PREFLIGHT_EXIT=%errorlevel%"
popd

if not "%PREFLIGHT_EXIT%"=="0" (
  echo.
  echo [ERROR] daemon preflight failed ^(exit %PREFLIGHT_EXIT%^). Window NOT opened.
  echo         Read the output above, or inspect the port owner with:
  echo           netstat -ano ^| findstr :19820
  pause
  exit /b 1
)

rem Never leak the preflight-only flag into the shell process.
set "ELECTRON_RUN_AS_NODE="
start "MWH" /D "%ROOT%shell" "%ELECTRON_EXE%" .
echo MWH shell launched detached. Use the tray icon (MWH logo) to Quit.
ping 127.0.0.1 -n 2 >nul
endlocal
