@echo off
cd /d "%~dp0"
start "GreenApple.remove local server" /min "D:\nodejs\node.exe" "%~dp0server.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:4174/
