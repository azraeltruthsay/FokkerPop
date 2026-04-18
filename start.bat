@echo off
title FokkerPop
cd /d "%~dp0"

:: Use bundled Node if present, otherwise fall back to system Node
if exist "node\node.exe" (
    set NODE=node\node.exe
) else (
    set NODE=node
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
