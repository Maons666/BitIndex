@echo off
cd /d "%~dp0"
echo BitIndex - http://127.0.0.1:8787
echo Keep this window open while using the dashboard.
node dashboard/server.mjs
pause
