@echo off
echo Checking IPvFoo Collector Server...
wmic process where "name='pythonw.exe' and commandline like '%%server.py%%'" get ProcessId 2>nul | find /i "ProcessId" >nul
if %errorlevel%==0 (
    echo Server is RUNNING.
    start http://127.0.0.1:3456
) else (
    echo Server is NOT running.
    echo Start it with start_server.vbs
)
pause
