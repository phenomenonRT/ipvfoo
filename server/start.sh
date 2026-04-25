#!/bin/bash
cd "$(dirname "$0")"
echo ""
echo " ================================"
echo "  IPvFoo Collector Server"
echo " ================================"
echo ""
echo " Веб-интерфейс: http://127.0.0.1:3456"
echo " Для остановки нажмите Ctrl+C"
echo ""
python3 server.py
