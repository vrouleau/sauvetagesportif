@echo off
REM Simulate results in the SauvetageMeet SQLite database.
REM Writes random SWIMTIME into all SWIMRESULT rows that have no time yet.
REM SWIMTIME = ENTRYTIME +/- 5%%, or random 30-180s if NT. 5%% get DSQ.
REM
REM Usage: simulate_results.bat [path_to_meet.db]
REM Default: auto-detects packaged (%APPDATA%\SauvetageMeet) vs. `npm run dev`
REM (%APPDATA%\SauvetageMeet-Dev) — see simulate_results.py's _default_db_path().
REM If both exist, pass the path explicitly instead of relying on the default.

setlocal
if "%~1"=="" (
    python "%~dp0simulate_results.py"
) else (
    echo Simulating results in: %~1
    python "%~dp0simulate_results.py" "%~1"
)
