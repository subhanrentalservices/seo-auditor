@echo off
rem Runs the Backlink Verifier. With no arguments, opens a terminal ready to use it.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo Run setup.bat first.
  pause
  exit /b 1
)
if "%~1"=="" (
  echo Backlink Verifier - type commands like:
  echo   linkverify add https://some-site.com/article --target yoursite.com --check
  echo   linkverify check --all
  echo   linkverify report
  echo   linkverify schedule install --time 10:00
  echo   linkverify dashboard
  echo.
  .venv\Scripts\python -m linkverify --help
  cmd /k
) else (
  .venv\Scripts\python -m linkverify %*
)
