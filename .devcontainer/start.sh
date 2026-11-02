#!/usr/bin/env bash
# Starts the app in the background whenever the Codespace starts. Log: /tmp/unified-calendar.log
cd "$(dirname "$0")/.."
pkill -f "node --no-warnings server.js" 2>/dev/null || true
nohup node --no-warnings server.js > /tmp/unified-calendar.log 2>&1 &
sleep 1
echo "Unified Calendar is starting on port 3000. Open the Ports tab and tap the link next to 3000."
