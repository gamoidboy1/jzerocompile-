@echo off
title JzeroCompile Server Component
echo ===================================================
echo     Starting JzeroCompile God-Tier C IDE...
echo ===================================================
echo.
echo Starting local Node compiler backend...
cd /d "%~dp0"

:: Start the node server in this console window
start /B npm start

:: Wait 2 seconds for server to initialize
timeout /t 2 /nobreak > nul

:: Open the user's default web browser to the server address
echo Opening frontend in your default browser...
start http://localhost:3000

echo.
echo Server is running! Keep this window open to compile C code.
echo (You can minimize this window).
pause > nul
