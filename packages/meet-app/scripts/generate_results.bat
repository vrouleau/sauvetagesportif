@echo off
REM Fill realistic random results (individual + relay, pool times or beach
REM positions) into the SauvetageMeet SQLite database, with a configurable
REM DSQ rate. See generate_results.py's docstring for the full workflow.
REM
REM Usage: generate_results.bat [path_to_meet.db] [dsq_pct]
REM Default: auto-detects packaged (%APPDATA%\SauvetageMeet) vs. `npm run dev`
REM (%APPDATA%\SauvetageMeet-Dev) — see generate_results.py's _default_db_path().
REM If both exist, pass the path explicitly instead of relying on the default.
REM dsq_pct defaults to 5 (percent) if omitted.

setlocal
set DSQ_PCT=%2
if "%DSQ_PCT%"=="" set DSQ_PCT=5

if "%~1"=="" (
    python "%~dp0generate_results.py" --dsq-pct %DSQ_PCT%
) else (
    echo Generating results in: %~1
    python "%~dp0generate_results.py" "%~1" --dsq-pct %DSQ_PCT%
)
