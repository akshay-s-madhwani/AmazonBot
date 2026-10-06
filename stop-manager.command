#!/bin/bash
# Stops the slots, then the manager. Browsers stay open by design.
# macOS twin of stop-manager.bat.
curl -s -X POST http://127.0.0.1:7800/fleet/stop >/dev/null 2>&1
sleep 1
PIDS="$(lsof -nP -t -iTCP:7800 -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PIDS" ]; then
  # SIGINT is the manager's own shutdown: it logs the slots it leaves running.
  kill -INT $PIDS 2>/dev/null
  sleep 2
  for p in $PIDS; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null; done
  echo "  Manager stopped."
else
  echo "  Manager was not running."
fi
echo
read -r -p "  Press Enter to close..." _
