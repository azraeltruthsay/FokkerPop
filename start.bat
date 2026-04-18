@echo off
setlocal
title FokkerPop
cd /d "%~dp0"

:: Create logs folder if it does not exist
if not exist "logs" mkdir "logs"

echo:
echo  ==========================================
echo    FokkerPop : Diagnostic Check
echo  ==========================================
echo:
echo  Current Folder: "%cd%"
echo:

:: 1. Check if running from a Temp folder (un-extracted ZIP)
echo "%cd%" | findstr /i "Temp" >nul
if %errorlevel% equ 0 (
    echo:
    echo  ERROR: You are running this from a Temporary folder.
    echo:
    echo  It looks like you opened the ZIP but did not EXTRACT it.
    echo  FokkerPop cannot run from inside a ZIP file.
    echo:
    echo  TO FIX THIS:
    echo  1. Close this window.
    echo  2. Right-click the ZIP file and choose "Extract All..."
    echo  3. Open the NEW folder that is created.
    echo  4. Run start.bat from there.
    echo:
    pause
    exit /b
)

:: 2. Check for bundled Node (Release Indicator)
if not exist "node\node.exe" (
    echo:
    echo  ERROR: Missing bundled Node.js.
    echo:
    echo  It looks like you downloaded the "Source Code" zip instead of
    echo  the "Release" zip. The source code does not work without
    echo  manual setup ^(npm install^).
    echo:
    echo  TO FIX THIS:
    echo  1. Go to: https://github.com/azraeltruthsay/FokkerPop/releases
    echo  2. Find the LATEST release.
    echo  3. Under "Assets", click: FokkerPop-vX.X.X-windows.zip
    echo     ^(NOT the Source code links^)
    echo:
    pause
    exit /b
)

set NODE=node\node.exe

:: 3. Check for missing dependencies
if not exist "node_modules\ws" (
    echo:
    echo  ERROR: Missing node_modules.
    echo:
    echo  The application folder is incomplete.
    echo  Try extracting the release zip again to a new folder.
    echo:
    pause
    exit /b
)

:: 4. Unblock node.exe (Windows marks downloaded files as untrusted)
powershell -NoProfile -Command "Unblock-File -Path ('node\node.exe')" >nul 2>&1

:: 5. Verify node.exe runs
"%NODE%" -v >nul 2>&1
if %errorlevel% neq 0 (
    echo:
    echo  ERROR: Bundled Node.js is failing to execute.
    echo:
    echo  Most likely cause: Antivirus or Windows Security is blocking node.exe.
    echo:
    echo  TO FIX THIS:
    echo  1. Open Windows Security ^(search it in the Start menu^)
    echo  2. Go to: Virus ^& threat protection
    echo  3. Under "Current threats", look for node.exe and click Allow
    echo  --- OR ---
    echo  1. Right-click the "node" folder in this directory
    echo  2. Open "node.exe" Properties
    echo  3. At the bottom tick "Unblock" then click OK
    echo  4. Run start.bat again.
    echo:
    pause
    exit /b
)

cls
echo:
echo  ==========================================
echo    FokkerPop v0.1.14 : Starting up...
echo  ==========================================
echo:
echo  Overlay:    http://localhost:4747
echo  Dashboard:  http://localhost:4747/dashboard
echo:
echo  Add the Overlay URL as a Browser Source in OBS ^(1920x1080^).
echo:
echo  Opening Dashboard in 3 seconds...
echo:

:: Launch browser then start server
timeout /t 3 /nobreak >nul 2>&1

start http://localhost:4747/dashboard

"%NODE%" server/index.js
pause

