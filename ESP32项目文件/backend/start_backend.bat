@echo off
rem ESP32 backend auto-start script: skip if already running, otherwise start.
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 exit /b 0
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" src/server.js
