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
if not exist "node\FokkerPop.exe" (
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

set NODE=node\FokkerPop.exe

:: 3. Check for missing dependencies
if not exist "node_modules\ws" (
    echo  ERROR: Missing node_modules.
    echo  The application folder is incomplete.
    echo  Try extracting the release zip again to a new folder.
    pause
    exit /b
)

:: 4. Unblock FokkerPop.exe (Windows marks downloaded files as untrusted)
powershell -NoProfile -Command "Unblock-File -Path ('node\FokkerPop.exe')" >nul 2>&1

:: 5. Verify FokkerPop.exe runs
"%NODE%" -v >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Bundled Node.js is failing to execute.
    echo  Most likely cause: Antivirus or Windows Security is blocking FokkerPop.exe.
    echo  TO FIX THIS:
    echo  1. Open Windows Security ^(search it in the Start menu^)
    echo  2. Go to: Virus ^& threat protection
    echo  3. Under "Current threats", look for FokkerPop.exe and click Allow
    echo  --- OR ---
    echo  1. Right-click the "node" folder in this directory
    echo  2. Open "FokkerPop.exe" Properties
    echo  3. At the bottom tick "Unblock" then click OK
    echo  4. Run start.bat again.
    pause
    exit /b
)

cls
echo  ==========================================
echo    FokkerPop : Starting up...
echo  ==========================================
echo:
echo  [!] IMPORTANT: DO NOT CLICK INSIDE THIS BLACK WINDOW.
echo      If you do, Windows might "pause" the server.
echo      If things stop working, click here and press ENTER.
echo:
echo  Overlay URL:   http://localhost:4747
echo  Dashboard URL: http://localhost:4747/dashboard
echo:
echo  The dashboard should open in your browser automatically.
echo  Keep this window open in the background while streaming.
echo:

"%NODE%" server/index.js
pause

