@echo off
REM Simulate results in the SauvetageMeet SQLite database.
REM Writes random SWIMTIME into all SWIMRESULT rows that have no time yet.
REM SWIMTIME = ENTRYTIME +/- 5%%, or random 30-180s if NT. 5%% get DSQ.
REM
REM Usage: simulate_results.bat [path_to_meet.db]
REM Default: %APPDATA%\SauvetageMeet\meet.db

setlocal
if "%~1"=="" (
    set "DB=%APPDATA%\SauvetageMeet\meet.db"
) else (
    set "DB=%~1"
)

echo Simulating results in: %DB%
python "%~dp0simulate_results.py" "%DB%"
