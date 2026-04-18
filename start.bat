@echo off
setlocal
title FokkerPop
cd /d "%~dp0"

:: Create logs folder if it does not exist
if not exist "logs" mkdir "logs"

echo  ==========================================
echo    FokkerPop : Diagnostic Check
echo  ==========================================
echo  Current Folder: "%cd%"

:: 1. Check if running from a Temp folder (un-extracted ZIP)
echo "%cd%" | findstr /i "Temp" >nul
if %errorlevel% equ 0 (
    echo  ERROR: You are running this from a Temporary folder.
    echo  It looks like you opened the ZIP but did not EXTRACT it.
    echo  FokkerPop cannot run from inside a ZIP file.
    echo  TO FIX THIS:
    echo  1. Close this window.
    echo  2. Right-click the ZIP file and choose "Extract All..."
    echo  3. Open the NEW folder that is created.
    echo  4. Run start.bat from there.
    pause
    exit /b
)

:: 2. Check for bundled Node (Release Indicator)
if not exist "node\node.exe" (
    echo  ERROR: Missing bundled Node.js.
    echo  It looks like you downloaded the "Source Code" zip instead of
    echo  the "Release" zip. The source code does not work without
    echo  manual setup ^(npm install^).
    echo  TO FIX THIS:
    echo  1. Go to: https://github.com/azraeltruthsay/FokkerPop/releases
    echo  2. Find the LATEST release.
    echo  3. Under "Assets", click: FokkerPop-vX.X.X-windows.zip
    echo     ^(NOT the Source code links^)
    pause
    exit /b
)

set NODE=node\node.exe

:: 3. Check for missing dependencies
if not exist "node_modules\ws" (
    echo  ERROR: Missing node_modules.
    echo  The application folder is incomplete.
    echo  Try extracting the release zip again to a new folder.
    pause
    exit /b
)

:: 4. Unblock node.exe (Windows marks downloaded files as untrusted)
powershell -NoProfile -Command "Unblock-File -Path ('node\node.exe')" >nul 2>&1

:: 5. Verify node.exe runs
"%NODE%" -v >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Bundled Node.js is failing to execute.
    echo  Most likely cause: Antivirus or Windows Security is blocking node.exe.
    echo  TO FIX THIS:
    echo  1. Open Windows Security ^(search it in the Start menu^)
    echo  2. Go to: Virus ^& threat protection
    echo  3. Under "Current threats", look for node.exe and click Allow
    echo  --- OR ---
    echo  1. Right-click the "node" folder in this directory
    echo  2. Open "node.exe" Properties
    echo  3. At the bottom tick "Unblock" then click OK
    echo  4. Run start.bat again.
    pause
    exit /b
)

cls
echo  ==========================================
echo    FokkerPop : Starting up...
echo  ==========================================
echo  Overlay URL will be shown in this window once started.
echo  The dashboard will open in your browser automatically.
echo  Add the Overlay URL as a Browser Source in OBS ^(1920x1080^).

timeout /t 3 /nobreak >nul 2>&1


"%NODE%" server/index.js
pause

