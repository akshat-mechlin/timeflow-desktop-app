@echo off
echo Starting Windows build...

REM Kill processes
taskkill /F /IM electron.exe /T >nul 2>&1
taskkill /F /IM "Time Tracker.exe" /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Clean dist
if exist dist rmdir /s /q dist 2>nul

REM Clear cache
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" 2>nul
)

REM Set environment variable and build
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo Building (code signing disabled)...
call npx electron-builder --win

if %ERRORLEVEL% EQU 0 (
    echo Build completed successfully!
) else (
    echo Build failed with exit code: %ERRORLEVEL%
    exit /b %ERRORLEVEL%
)



