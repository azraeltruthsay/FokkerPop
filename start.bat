@echo off
title FokkerPop
cd /d "%~dp0"

echo.
echo  ==========================================
echo    FokkerPop  ^|  Diagnostic Check...
echo  ==========================================

:: 1. Check for bundled Node (Release Indicator)
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
    echo  2. Refresh the page and find the LATEST release.
    echo  3. Under "Assets", click: 'FokkerPop-vX.X.X-windows.zip'
    echo     (NOT the 'Source code' links!)
    echo.
    echo  Running from: %cd%
    echo.
    pause
    exit /b
)

set NODE=node\node.exe

:: 2. Check for missing dependencies
if not exist "node_modules\ws" (
    echo.
    echo  ERROR: Missing 'node_modules'.
    echo.
    echo  The application folder is incomplete. If you used the correct 
    echo  zip, please try extracting it again to a new folder.
    echo.
    echo  Running from: %cd%
    echo.
    pause
    exit /b
)

:: 3. Verification check
%NODE% -v >nul 2>&1
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
echo    FokkerPop  ^|  Starting up...
echo  ==========================================
echo.
echo  Overlay:    http://localhost:4747
echo  Dashboard:  http://localhost:4747/dashboard
echo.
echo  Add the Overlay URL as a Browser Source in OBS (1920x1080).
echo  Open the Dashboard URL to configure and test effects.
echo.

%NODE% server/index.js
pause
