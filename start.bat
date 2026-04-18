@echo off
title FokkerPop
cd /d "%~dp0"

:: 1. Check for bundled Node, fall back to system Node
if exist "node\node.exe" (
    set NODE=node\node.exe
) else (
    set NODE=node
)

:: 2. Check for missing dependencies
if not exist "node_modules\ws" (
    echo.
    echo  ==========================================================
    echo    ERROR: Missing Dependencies
    echo  ==========================================================
    echo.
    echo    It looks like the 'node_modules' folder is missing. 
    echo    This usually happens if you downloaded the "Source Code" 
    echo    zip from the main GitHub page instead of the Release.
    echo.
    echo    TO FIX THIS:
    echo    1. Go to: https://github.com/azraeltruthsay/FokkerPop/releases
    echo    2. Download 'FokkerPop-v0.1.0-windows.zip' (NOT the source code)
    echo    3. Extract that zip and run start.bat from there.
    echo.
    echo    OR (for developers):
    echo    Run 'npm install' in this folder.
    echo.
    pause
    exit /b
)

:: 3. Check if Node is actually available
%NODE% -v >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js was not found. 
    echo  Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b
)

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
