@echo off
setlocal
title FokkerPop — Stop

echo.
echo  Stopping FokkerPop...
echo.

:: Try a graceful HTTP-triggered shutdown first so in-flight writes complete.
:: If the server isn't listening, curl fails fast and we fall through to kill.
curl -fsS -X POST -m 2 http://127.0.0.1:4747/api/shutdown >nul 2>&1

:: Belt-and-braces — taskkill anything still alive. /T includes child processes.
taskkill /F /IM FokkerPop.exe /T >nul 2>&1

if %errorlevel% equ 0 (
    echo  FokkerPop stopped.
) else (
    echo  FokkerPop was not running.
)

timeout /t 2 /nobreak >nul
endlocal
