@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------------
rem  zer0ne Code - build the app.
rem  Run it after any change. The app is then in:
rem      dist\win-unpacked\zer0ne Code.exe
rem
rem  build.bat            build
rem  build.bat run        build, then start the app
rem  build.bat installer  build, then create dist\zer0ne-Code-Setup-<version>.exe
rem  build.bat test       build, then run the app and engine tests
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
set "EXE=%~dp0dist\win-unpacked\zer0ne Code.exe"

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js is required to build. Install it from https://nodejs.org and try again.
	goto :fail
)

rem The built app locks its own files while it runs.
tasklist /FI "IMAGENAME eq zer0ne Code.exe" 2>nul | find /I "zer0ne Code.exe" >nul
if not errorlevel 1 (
	echo zer0ne Code is running. Quit it from the tray icon ^(right-click, Quit^) and build again.
	goto :fail
)

if not exist "node_modules\electron\package.json" (
	echo [1/3] Installing build tools...
	call npm ci
	if errorlevel 1 goto :fail
) else (
	echo [1/3] Build tools are installed.
)

if /I "%~1"=="test" (
	call node scripts\validate.js
	if errorlevel 1 goto :fail
	goto :done
)

echo [2/3] Building the engine...
call node scripts\build-engine.js
if errorlevel 1 goto :fail

echo [3/3] Packaging the app...
call node scripts\package.js
if errorlevel 1 goto :fail

if not exist "%EXE%" (
	echo The app was not produced at "%EXE%".
	goto :fail
)
echo.
echo Done: "%EXE%"

if /I "%~1"=="installer" (
	echo Creating the installer...
	call node scripts\installer.js
	if errorlevel 1 goto :fail
)

if /I "%~1"=="run" start "" "%EXE%"
:done
call :pause
exit /b 0

:fail
echo.
echo Build failed.
call :pause
exit /b 1

:pause
rem Keep the window open when the file was double-clicked.
echo %cmdcmdline% | find /I "/c" >nul
if not errorlevel 1 pause
exit /b 0
