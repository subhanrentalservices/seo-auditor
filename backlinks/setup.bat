@echo off
rem One-time setup of the link building engine (Python) used by SEO Auditor's "Link building" screens.
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (set PY=py -3) else (set PY=python)
%PY% --version >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install Python 3.12 or newer from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH". Then run this file again.
  pause
  exit /b 1
)
if not exist .venv (
  echo Creating a private Python environment...
  %PY% -m venv .venv || goto :fail
)
echo Installing libraries...
.venv\Scripts\python -m pip install --upgrade pip >nul
.venv\Scripts\python -m pip install -r requirements.txt pytest || goto :fail
echo Installing the headless browser for the JavaScript checks (about 150 MB)...
.venv\Scripts\python -m playwright install chromium || echo Browser install failed; checks 4 and 12 will be partly skipped.
echo.
echo Setup finished. Open SEO Auditor and choose "Link building" in the sidebar.
pause
exit /b 0
:fail
echo Setup failed. Scroll up to see the error.
pause
exit /b 1
