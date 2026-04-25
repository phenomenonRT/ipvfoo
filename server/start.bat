@echo off
title IPvFoo Collector Server
echo.
echo  ================================
echo   IPvFoo Collector Server
echo  ================================
echo.
echo  Веб-интерфейс: http://127.0.0.1:3456
echo  Для остановки нажмите Ctrl+C
echo.
python server.py
if %errorlevel% neq 0 (
    echo.
    echo  [ОШИБКА] Python не найден или произошла ошибка.
    echo  Убедитесь что Python 3 установлен: https://python.org
    echo.
    pause
)
