#!/usr/bin/env bash
# Start the fleet manager (Express, default :7800).
#
#   scripts/manager.sh                 run in the foreground (Ctrl-C to stop)
#   scripts/manager.sh --background    detach; logs to artifacts/manager.log
#   scripts/manager.sh --port 7900     use a different port
#   scripts/manager.sh --id 101        run as node 101 (only its sheet rows)
#   scripts/manager.sh --build         force a rebuild first
#
# Refuses to start a second manager on a port that already has one — a stale
# manager silently serving requests has confused a debugging session before.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

BACKGROUND=0
FORCE_BUILD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --background|-b) BACKGROUND=1; shift ;;
    --port|-p)       MANAGER_PORT="${2:?--port needs a number}"; MANAGER_URL="http://127.0.0.1:$MANAGER_PORT"; shift 2 ;;
    --id)            export NODE_ID="${2:?--id needs a value}"; shift 2 ;;
    --id=*)          export NODE_ID="${1#--id=}"; shift ;;
    --build)         FORCE_BUILD=1; shift ;;
    -h|--help)       sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               die "unknown option: $1 (try --help)" ;;
  esac
done

cd "$BOT_DIR"

if [ "$FORCE_BUILD" = "1" ] || [ ! -f dist/manager.js ]; then
  info "building..."
  npm run build >/dev/null || die "build failed — run 'npm run build' to see the errors"
fi

# Refuse to double-start.
existing="$(pids_on_port "$MANAGER_PORT" || true)"
if [ -n "$existing" ]; then
  if manager_up; then
    die "a manager is ALREADY running on port $MANAGER_PORT (pid $(echo "$existing" | tr '\n' ' '))
Stop it first:  scripts/kill-manager.sh"
  fi
  die "port $MANAGER_PORT is occupied by pid $(echo "$existing" | tr '\n' ' ') but it is not the manager.
Free the port, or use:  scripts/manager.sh --port 7900"
fi

export MANAGER_PORT
mkdir -p artifacts

# Surface the identity before starting — running as the wrong node means
# logging into another machine's accounts.
info "node_id: $(node_id_current || echo '(blank)') ($(node_id_source))"

if [ "$BACKGROUND" = "1" ]; then
  logfile="$BOT_DIR/artifacts/manager.log"
  nohup node dist/manager.js >>"$logfile" 2>&1 &
  disown || true
  sleep 2
  if manager_up; then
    portflag=""
    [ "$MANAGER_PORT" != "7800" ] && portflag=" --port $MANAGER_PORT"
    ok "manager running on $MANAGER_URL (background)"
    info "  logs:  tail -f $logfile"
    info "  stop:  scripts/kill-manager.sh$portflag"
  else
    die "manager did not come up — see $logfile"
  fi
else
  info "manager starting on $MANAGER_URL — Ctrl-C to stop"
  info "${C_DIM}browsers deliberately OUTLIVE this process; use kill-browsers.sh to close them${C_0}"
  exec node dist/manager.js
fi
