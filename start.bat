@echo off
setlocal
title FokkerPop
cd /d "%~dp0"

echo.
echo  ==========================================
echo    FokkerPop : Diagnostic Check
echo  ==========================================
echo.
echo  Current Folder: "%cd%"
echo.

:: 1. Check if running from a Temp folder (un-extracted ZIP)
echo "%cd%" | findstr /i "Temp" >nul
if %errorlevel% equ 0 (
    echo.
    echo  ERROR: You are running this from a Temporary folder.
    echo.
    echo  It looks like you opened the ZIP but didn't EXTRACT it.
    echo  FokkerPop cannot run from inside a ZIP file.
    echo.
    echo  TO FIX THIS:
    echo  1. Close this window.
    echo  2. Right-click the ZIP file and choose "Extract All..."
    echo  3. Open the NEW folder that is created.
    echo  4. Run start.bat from there.
    echo.
    pause
    exit /b
)

:: 2. Check for bundled Node (Release Indicator)
if not exist "node\node.exe" (
    echo.
    echo  ERROR: Missing bundled Node.js.
    echo.
    echo  It looks like you downloaded the "Source Code" zip instead of 
    echo  the "Release" zip. The source code does not work without 
    echo  manual setup (npm install).
    echo.
    echo  TO FIX THIS:
    echo  1. Go to: https://github.com/azraeltruthsay/FokkerPop/releases
    echo  2. Refresh the page and find the LATEST release (v0.1.7+).
    echo  3. Under "Assets", click: 'FokkerPop-vX.X.X-windows.zip'
    echo     (NOT the 'Source code' links!)
    echo.
    echo  TIP: Detailed logs are stored in the "logs" folder.
    echo.
    pause
    exit /b
)

set NODE=node\node.exe

:: 3. Check for missing dependencies
if not exist "node_modules\ws" (
    echo.
    echo  ERROR: Missing 'node_modules'.
    echo.
    echo  The application folder is incomplete. If you used the correct 
    echo  zip, please try extracting it again to a new folder.
    echo.
    echo  TIP: Detailed logs are stored in the "logs" folder.
    echo.
    pause
    exit /b
)

:: 4. Final verification
"%NODE%" -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Bundled Node.js is failing to execute.
    echo  Your antivirus or Windows security may be blocking it.
    echo.
    pause
    exit /b
)

cls
echo.
echo  ==========================================
echo    FokkerPop : Starting up...
echo  ==========================================
echo.
echo  Overlay:    http://localhost:4747
echo  Dashboard:  http://localhost:4747/dashboard
echo.
echo  Add the Overlay URL as a Browser Source in OBS (1920x1080).
echo.
echo  Opening Dashboard in 3 seconds...
echo.

:: Launch the browser directly from the BAT (more reliable than Node's exec)
:: Use ping for delay if timeout is missing, but timeout is standard on Win7+
timeout /t 3 /nobreak >nul 2>&1 || ping 127.0.0.1 -n 4 >nul

start http://localhost:4747/dashboard

"%NODE%" server/index.js
pause
