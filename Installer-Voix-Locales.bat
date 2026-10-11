@echo off
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /D "%~dp0"
if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"
uv run start.py --voix
pause
