@echo off
title AI Hand Detection Presentation
cd /d "%~dp0"
set "PY=python"
where python >nul 2>nul || set "PY=py"
"%PY%" -c "import streamlit, fitz, PIL, mammoth" >nul 2>nul
if errorlevel 1 (
  echo Installing the required Python packages (first run only)...
  "%PY%" -m pip install -r requirements.txt
)
"%PY%" main.py %*
if errorlevel 1 pause
