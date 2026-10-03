#!/usr/bin/env bash
# Shared helpers for the bot utility scripts. Sourced, never run directly.
#
# Windows/Git Bash notes that shaped this file:
#   - jq is NOT present in Git Bash, so JSON is parsed with node (always
#     available — this is a Node project).
#   - `pkill -f dist/manager.js` does NOT kill the manager on Windows. Processes
#     are found by their LISTENING port via netstat and killed by PID.
#   - MSYS rewrites arguments that look like paths, so `taskkill /F /PID` turns
#     into garbage. Always use the `//F //PID` double-slash form.

set -euo pipefail

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGER_PORT="${MANAGER_PORT:-7800}"
MANAGER_URL="${MANAGER_URL:-http://127.0.0.1:${MANAGER_PORT}}"

# This machine's node identity. Only Users rows whose node_id matches are run,
# so one sheet can drive many machines without them stealing each other's work.
# Precedence: --id flag (exports NODE_ID) > NODE_ID env > .node-id file.
NODE_ID_FILE="$BOT_DIR/.node-id"

node_id_current() {
  if [ -n "${NODE_ID:-}" ]; then
    printf '%s' "$NODE_ID"
  elif [ -f "$NODE_ID_FILE" ]; then
    tr -d '[:space:]' < "$NODE_ID_FILE"
  fi
}

node_id_source() {
  if   [ -n "${NODE_ID:-}" ];   then printf 'NODE_ID env / --id'
  elif [ -s "$NODE_ID_FILE" ];  then printf '.node-id file'
  else                               printf 'unset'
  fi
}

# Pulls `--id X` out of the argument list and exports NODE_ID. Call as:
#   eval "$(extract_id_flag "$@")"
# so the caller keeps the remaining arguments.
extract_id_flag() {
  local out=() id=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --id) id="${2:-}"; shift 2 ;;
      --id=*) id="${1#--id=}"; shift ;;
      *) out+=("$1"); shift ;;
    esac
  done
  [ -n "$id" ] && printf 'export NODE_ID=%q; ' "$id"
  printf 'set --'
  for a in ${out[@]+"${out[@]}"}; do printf ' %q' "$a"; done
}

if [ -t 1 ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'
  C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else
  C_RED=""; C_GRN=""; C_YEL=""; C_DIM=""; C_B=""; C_0=""
fi

info() { printf '%s\n' "$*" >&2; }
warn() { printf '%s%s%s\n' "$C_YEL" "$*" "$C_0" >&2; }
ok()   { printf '%s%s%s\n' "$C_GRN" "$*" "$C_0" >&2; }
die()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_0" >&2; exit 1; }

# json <js-expression>   — reads JSON on stdin, `j` is the parsed value.
# Exits 3 when the expression yields null/undefined, so callers can branch.
json() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); }
      catch { process.stderr.write("not JSON: " + s.slice(0, 300) + "\n"); process.exit(1); }
      let out;
      try { out = new Function("j", "return (" + process.argv[1] + ")")(j); }
      catch (e) { process.stderr.write("bad expr: " + e.message + "\n"); process.exit(1); }
      if (out === undefined || out === null) process.exit(3);
      process.stdout.write(typeof out === "string" ? out : JSON.stringify(out));
    });
  ' "$1"
}

# api <METHOD> <url> [curl args...] — fails loudly on a non-2xx response.
api() {
  local method="$1" url="$2"; shift 2
  local body code
  body="$(curl -sS -X "$method" -w $'\n%{http_code}' "$url" "$@" 2>/dev/null || true)"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ -z "$code" ] || [ "$code" -lt 200 ] 2>/dev/null || [ "$code" -ge 300 ] 2>/dev/null; then
    printf '%s' "$body" >&2
    printf '\n' >&2
    return 1
  fi
  printf '%s' "$body"
}

manager_up() { curl -sS --max-time 3 "$MANAGER_URL/health" >/dev/null 2>&1; }

require_manager() {
  manager_up || die "manager is not running on $MANAGER_URL — start it with: scripts/manager.sh"
}

require_build() {
  [ -f "$BOT_DIR/dist/manager.js" ] || die "not built — run: npm run build (in $BOT_DIR)"
}

# pids_on_port <port> — PIDs LISTENING on a TCP port (Windows netstat).
pids_on_port() {
  netstat -ano 2>/dev/null \
    | grep -i 'LISTENING' \
    | grep -E "[:.]$1[[:space:]]" \
    | awk '{print $NF}' \
    | grep -E '^[0-9]+$' \
    | sort -u
}

# kill_pid <pid> [label] — taskkill with the MSYS-safe double-slash flags.
kill_pid() {
  local pid="$1" label="${2:-pid $1}"
  if [ -z "$pid" ] || [ "$pid" = "0" ]; then return 1; fi
  if taskkill //F //T //PID "$pid" >/dev/null 2>&1; then
    ok "killed $label (pid $pid)"
    return 0
  fi
  warn "could not kill $label (pid $pid) — already gone?"
  return 1
}

pid_alive() { taskkill //PID "$1" //F //T -? >/dev/null 2>&1; ps -p "$1" >/dev/null 2>&1; }

# fleet_status — cached per invocation so we don't hammer the manager.
fleet_status() {
  if [ -z "${_FLEET_CACHE:-}" ]; then
    _FLEET_CACHE="$(api GET "$MANAGER_URL/fleet/status")" || die "could not read fleet status"
  fi
  printf '%s' "$_FLEET_CACHE"
}
