@echo off
setlocal EnableDelayedExpansion

echo.
echo  ===================================
echo    Claude Haha - Installer
echo  ===================================
echo.

set "BIN_DIR=%~dp0bin"

:: Check if already in PATH
echo %PATH% | findstr /I /C:"%BIN_DIR%" >nul 2>&1
if %errorlevel%==0 (
    echo  [OK] bin directory is already in PATH.
    echo.
    echo  You can run 'claude-haha' from any directory.
    goto :done
)

:: Add to user PATH permanently
echo  Adding "%BIN_DIR%" to user PATH...
for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%b"
if not defined USER_PATH (
    set "NEW_PATH=%BIN_DIR%"
) else (
    set "NEW_PATH=!USER_PATH!;%BIN_DIR%"
)
reg add "HKCU\Environment" /v Path /t REG_EXPAND_SZ /d "!NEW_PATH!" /f >nul 2>&1

:: Also update current session
set "PATH=%PATH%;%BIN_DIR%"

:: Broadcast environment change to other processes
rundll32 user32.dll,UpdatePerUserSystemParameters 1, True >nul 2>&1

echo.
echo  [OK] Installation complete!
echo.
echo  Usage:
echo    PowerShell / CMD:   claude-haha.bat
echo    Git Bash:           claude-haha
echo.
echo  NOTE: Please restart your terminal for PATH changes to take effect.
echo.

:done
endlocal
