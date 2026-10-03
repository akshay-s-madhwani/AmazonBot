#!/usr/bin/env bash
# Stop the fleet manager.
#
#   scripts/kill-manager.sh              graceful: stop slots, then the manager
#   scripts/kill-manager.sh --hard       skip the graceful stop, kill the port
#   scripts/kill-manager.sh --port 7900  a manager on a non-default port
#
# Killing the manager does NOT close the browsers — that is by design, so a
# crashed manager never costs you a logged-in session. Use kill-browsers.sh.
#
# Windows: `pkill -f dist/manager.js` does not work here. The manager is found
# by whoever is LISTENING on its port.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

HARD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hard)    HARD=1; shift ;;
    --port|-p) MANAGER_PORT="${2:?--port needs a number}"; MANAGER_URL="http://127.0.0.1:$MANAGER_PORT"; shift 2 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)         die "unknown option: $1 (try --help)" ;;
  esac
done

pids="$(pids_on_port "$MANAGER_PORT" || true)"

if [ -z "$pids" ]; then
  info "no process is listening on port $MANAGER_PORT — nothing to stop"
  exit 0
fi

# Ask it to stop its slots first, so slot processes don't linger as orphans.
if [ "$HARD" = "0" ] && manager_up; then
  stopped="$(api POST "$MANAGER_URL/fleet/stop" 2>/dev/null | json 'j.stopped' 2>/dev/null || echo "?")"
  info "asked the manager to stop its slots (stopped: $stopped)"
  sleep 1
fi

rc=0
for pid in $pids; do
  kill_pid "$pid" "manager on :$MANAGER_PORT" || rc=1
done

sleep 1
if pids_on_port "$MANAGER_PORT" >/dev/null 2>&1 && [ -n "$(pids_on_port "$MANAGER_PORT" || true)" ]; then
  die "port $MANAGER_PORT is still held — try: scripts/kill-manager.sh --hard"
fi

ok "manager stopped"
info "${C_DIM}browsers from this fleet are still open — scripts/kill-browsers.sh all${C_0}"
exit $rc
