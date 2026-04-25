@echo off
echo Stopping IPvFoo Collector Server...
wmic process where "name='pythonw.exe' and commandline like '%%server.py%%'" delete >nul 2>&1
if %errorlevel%==0 (
    echo Server stopped.
) else (
    echo Server was not running.
)
pause
