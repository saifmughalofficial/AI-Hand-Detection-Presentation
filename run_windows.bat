@echo off
title AI Hand Detection Presentation
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" (
  set "PY=.venv\Scripts\python.exe"
) else (
  where python >nul 2>nul || set "PY=py"
)
"%PY%" main.py %*
if errorlevel 1 pause
