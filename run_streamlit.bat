@echo off
title AI Hand Detection Presentation (Streamlit)
cd /d "%~dp0"
set "PY=python"
if exist ".venv\Scripts\python.exe" (
  set "PY=.venv\Scripts\python.exe"
) else (
  where python >nul 2>nul || set "PY=py"
)
rem localhost only: browsers allow the webcam on localhost, not on the network address.
"%PY%" -m streamlit run app.py --server.port 8765 --server.address localhost --browser.serverAddress localhost
if errorlevel 1 pause
