#!/bin/bash
echo "Starting Calcutta Dashboard server..."
echo "Open http://localhost:8080/calcutta_dashboard.html in Chrome"
echo "Press Ctrl+C to stop"
cd "$(dirname "$0")/../dashboard"
python3 -m http.server 8080
