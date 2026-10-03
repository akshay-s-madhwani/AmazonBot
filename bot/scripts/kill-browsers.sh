#!/usr/bin/env bash
# Close bot-owned ShardX browsers; ordinary Chrome is excluded.
#
#   scripts/kill-browsers.sh --list          show every browser, owned + orphaned
#   scripts/kill-browsers.sh 0               close slot 0's browser
#   scripts/kill-browsers.sh run-1786...-0   close that run's browser
#   scripts/kill-browsers.sh 23740           close that browser pid
#   scripts/kill-browsers.sh all             close every browser the manager owns
#   scripts/kill-browsers.sh --orphans       close browsers no live slot owns
#   scripts/kill-browsers.sh --really-all    close EVERY detected bot browser on this machine
#
#   --dry-run   show what would be killed, kill nothing
#   --yes       skip the confirmation prompt
#
# WHY THIS IS FUSSY: browsers deliberately outlive their slot, so a browser you
# parked by hand looks exactly like a bot browser to `taskkill /IM chrome.exe`.
# A blanket kill has already destroyed a hand-parked session once, so the
# blanket path is opt-in, confirmed, and never what `all` means.
#
# One browser is MANY engine processes (a root plus content children), so
# this works on root processes and kills each as a tree.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

DRY=0; ASSUME_YES=0; MODE=""; TARGET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --list|-l)    MODE="list"; shift ;;
    --orphans)    MODE="orphans"; shift ;;
    --really-all) MODE="really-all"; shift ;;
    all)         MODE="all"; shift ;;
    --dry-run|-n) DRY=1; shift ;;
    --yes|-y)     ASSUME_YES=1; shift ;;
    -h|--help)    sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)           die "unknown option: $1 (try --help)" ;;
    *)            TARGET="$1"; MODE="${MODE:-target}"; shift ;;
  esac
done

[ -n "$MODE" ] || { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1; }

# ── discovery ────────────────────────────────────────────────────────────────

# Bot browser roots discovered via CIM; ordinary Chrome is excluded.
browser_roots() {
  powershell.exe -NoProfile -NonInteractive -File "$(cygpath -w "$BOT_DIR/scripts/browser-roots.ps1")" | tr -d '\r'
}

# "<slotIndex> <runId> <browserPid>" per slot the manager currently knows.
owned_browsers() {
  manager_up || return 0
  local slots i port token runid idx st bpid
  slots="$(fleet_status | json 'j.slots.length' 2>/dev/null || echo 0)"
  [ "$slots" -gt 0 ] 2>/dev/null || return 0
  for ((i = 0; i < slots; i++)); do
    port="$(fleet_status  | json "j.slots[$i].port"      2>/dev/null || true)"
    token="$(fleet_status | json "j.slots[$i].token"     2>/dev/null || true)"
    idx="$(fleet_status   | json "j.slots[$i].slotIndex" 2>/dev/null || echo "$i")"
    runid="$(fleet_status | json "j.slots[$i].runId"     2>/dev/null || echo "?")"
    [ -n "$port" ] && [ -n "$token" ] || continue
    st="$(curl -sS --max-time 4 "http://127.0.0.1:$port/status?token=$token" 2>/dev/null || true)"
    [ -n "$st" ] || continue
    bpid="$(printf '%s' "$st" | json 'j.browser_pid' 2>/dev/null || true)"
    [ -n "$bpid" ] && printf '%s %s %s\n' "$idx" "$runid" "$bpid"
  done
}

kill_tree() {
  local pid="$1" label="$2"
  if [ "$DRY" = "1" ]; then info "  would kill $label (pid $pid)"; return 0; fi
  local owner
  owner="$(printf '%s\n' "$owned" | awk -v p="$pid" '$3 == p {print $1; exit}')"
  if [ -n "$owner" ]; then
    # The slot emits session.closed only after its browser is confirmed closed.
    # Bypassing it would strand the master's account reservation.
    load_slot "$owner"
    api POST "http://127.0.0.1:$PORT/cancel?token=$TOKEN" >/dev/null || die "could not close owned slot $owner safely"
    ok "closing $label through its slot"
    return 0
  fi
  kill_pid "$pid" "$label"
}

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  [ "$DRY" = "1" ] && return 0
  printf '%s%s%s ' "$C_YEL" "$1" "$C_0" >&2
  local reply; read -r reply || true
  [ "$reply" = "yes" ] || die "aborted (type exactly: yes)"
}

# ── modes ────────────────────────────────────────────────────────────────────

roots="$(browser_roots)" || die "browser discovery failed"
owned="$(owned_browsers || true)"
total_procs=$([ -n "$roots" ] && printf '%s\n' "$roots" | wc -l || echo 0)

case "$MODE" in

list)
  n_roots=$([ -n "$roots" ] && printf '%s\n' "$roots" | wc -l || echo 0)
  printf '%sbrowsers%s  %s root process(es), %s bot browser root(s) total\n\n' \
    "$C_B" "$C_0" "$(echo "$n_roots" | tr -d ' ')" "$total_procs"
  if [ -n "$owned" ]; then
    printf '  %-6s %-28s %-8s %s\n' "SLOT" "RUN" "PID" "STATE"
    while read -r idx runid bpid; do
      [ -n "$bpid" ] || continue
      state="running"
      printf '%s\n' "$roots" | grep -qx "$bpid" || state="${C_DIM}not found${C_0}"
      printf '  %-6s %-28s %-8s %b\n' "$idx" "$runid" "$bpid" "$state"
    done <<< "$owned"
  else
    # Three different reasons for an empty list — say which one it is rather
    # than collapsing them into one wrong-sounding message.
    if ! manager_up; then
      info "  (manager down — ownership unknown)"
    elif [ "$(fleet_status | json 'j.slots.length' 2>/dev/null || echo 0)" = "0" ]; then
      info "  (manager knows no slots)"
    else
      info "  (manager has slots, but none reported a browser pid —"
      info "   a slot started before this field existed will not report one;"
      info "   restart the slot, or match it by pid from the roots below)"
    fi
  fi
  # Orphans: roots nobody claims.
  orphan_list=""
  for pid in $roots; do
    printf '%s' "$owned" | awk '{print $3}' | grep -qx "$pid" || orphan_list="$orphan_list $pid"
  done
  if [ -n "${orphan_list// /}" ]; then
    printf '\n  %sunowned:%s%s\n' "$C_YEL" "$C_0" "$orphan_list"
    info "  close them with: scripts/kill-browsers.sh --orphans"
  fi
  exit 0
  ;;

target)
  # A bare number that matches a browser pid is treated as that pid; otherwise
  # it is a slot index, otherwise a run id.
  pid=""
  label=""
  if printf '%s\n' "$roots" | grep -qx "$TARGET"; then
    pid="$TARGET"; label="browser pid $TARGET"
  elif [ -n "$owned" ]; then
    match="$(printf '%s\n' "$owned" | awk -v t="$TARGET" '$1 == t || $2 == t {print; exit}')"
    if [ -n "$match" ]; then
      pid="$(printf '%s' "$match" | awk '{print $3}')"
      label="slot $(printf '%s' "$match" | awk '{print $1}') ($(printf '%s' "$match" | awk '{print $2}'))"
    fi
  fi
  [ -n "$pid" ] || die "no browser matches '$TARGET'.
Try:  scripts/kill-browsers.sh --list"
  kill_tree "$pid" "$label"
  ;;

all)
  [ -n "$owned" ] || die "the manager owns no browsers right now.
For browsers left behind by an earlier fleet:  scripts/kill-browsers.sh --orphans"
  info "closing $(printf '%s\n' "$owned" | wc -l | tr -d ' ') manager-owned browser(s):"
  while read -r idx runid bpid; do
    [ -n "$bpid" ] || continue
    kill_tree "$bpid" "slot $idx ($runid)"
  done <<< "$owned"
  ;;

orphans)
  orphan_list=""
  for pid in $roots; do
    printf '%s' "$owned" | awk '{print $3}' | grep -qx "$pid" || orphan_list="$orphan_list $pid"
  done
  orphan_list="${orphan_list# }"
  [ -n "$orphan_list" ] || { ok "no orphaned browsers"; exit 0; }
  manager_up || warn "manager is DOWN, so every browser looks unowned — including any you parked by hand."
  info "orphaned browser roots: $orphan_list"
  confirm "close these $(printf '%s\n' $orphan_list | wc -l | tr -d ' ') browser(s)? type 'yes':"
  for pid in $orphan_list; do kill_tree "$pid" "orphan"; done
  ;;

really-all)
  [ -n "$roots" ] || { ok "no bot browsers running"; exit 0; }
  warn "This closes EVERY detected bot browser on this machine — including any you"
  warn "opened yourself or parked for debugging. There is no undo."
  info "roots: $(printf '%s' "$roots" | tr '\n' ' ')($total_procs processes)"
  confirm "really close ALL browsers? type 'yes':"
  for pid in $roots; do kill_tree "$pid" "bot browser root"; done
  ;;

esac

[ "$DRY" = "1" ] && info "(dry run — nothing was killed)"
exit 0
