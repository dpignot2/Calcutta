@echo off
echo Starting Calcutta Dashboard server...
echo Open http://localhost:8080/calcutta_dashboard.html in Chrome
echo Press Ctrl+C to stop
cd /d "%~dp0..\dashboard"
python -m http.server 8080
