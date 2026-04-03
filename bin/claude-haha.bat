@echo off
setlocal
set "ROOT_DIR=%~dp0.."
C:\Users\kingdee\.bun\bin\bun.exe --preload "%ROOT_DIR%\preload.ts" --env-file="%ROOT_DIR%\.env" "%ROOT_DIR%\src\entrypoints\cli.tsx" %*
