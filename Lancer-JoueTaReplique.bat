@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /D "%~dp0"
title Joue ta replique - laisse cette fenetre ouverte

where uv >nul 2>nul
if errorlevel 1 (
    echo Premiere installation : telechargement de l'installateur...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
)
if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"

echo.
echo  Joue ta replique demarre. La premiere fois, l'installation prend 10 a 20 minutes.
echo  La page s'ouvrira toute seule dans ton navigateur.
echo.
uv run start.py --web
pause
