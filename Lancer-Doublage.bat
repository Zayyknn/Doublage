@echo off
setlocal
chcp 65001 >nul
set "PYTHONUTF8=1"
cd /D "%~dp0"
title Doublage

rem 1. uv (gestionnaire Python) : installe une seule fois
where uv >nul 2>nul
if errorlevel 1 (
    echo Installation de uv...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
)
if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"

rem 2. Acces depuis partout : tunnel Cloudflare gratuit si cloudflared est installe
where cloudflared >nul 2>nul
if not errorlevel 1 (
    echo Ouverture du tunnel Cloudflare dans une autre fenetre...
    start "Doublage - acces distant" cmd /k cloudflared tunnel --url http://localhost:8765
)

rem 3. Doublage (le premier lancement installe tout : 10 a 20 minutes)
uv run start.py --web
pause
