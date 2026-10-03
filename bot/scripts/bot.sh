#!/usr/bin/env bash
# The bot control CLI.
#
#   scripts/bot.sh id [n]              show or set this machine's node_id
#   scripts/bot.sh status              what every slot is doing right now
#   scripts/bot.sh steps               the step list with its resume indices
#   scripts/bot.sh start [n]           start n instances from the sheet
#   scripts/bot.sh continue <slot>     resume a stuck slot at the step it failed
#   scripts/bot.sh from <slot> <step>  resume at a specific step (index or name)
#   scripts/bot.sh restart <slot>      re-run from step 0 in the same browser
#   scripts/bot.sh stop <slot|all>     end the run (browser stays open)
#   scripts/bot.sh logs <slot|runId>   tail this run's structured events
#   scripts/bot.sh watch               live status, refreshing
#   scripts/bot.sh solo                one bot, no manager (uses .env)
#
# <slot> is a slot index (0, 1, …) or a run id. <step> is an index or a step
# name, so `from 0 select_payment` works as well as `from 0 7`.
#
# `--id 101` on any command runs as node 101 for that call only — it picks up
# only the Users rows whose node_id is 101. `bot.sh id 101` makes it permanent.
#
# The usual loop: a step fails -> the run parks with the browser open -> you fix
# the named cell in the sheet -> `continue` picks up in the SAME tab, re-reading
# the sheet. Nothing already completed is re-run.

source "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ── helpers ──────────────────────────────────────────────────────────────────

# Prints "port token runId slotIndex" for a slot index or run id.
resolve_slot() {
  local want="$1"
  require_manager
  local out
  out="$(fleet_status | json "
    (() => {
      const s = j.slots.find(x => String(x.slotIndex) === '$want' || x.runId === '$want');
      return s && s.port ? [s.port, s.token, s.runId, s.slotIndex].join(' ') : null;
    })()
  " 2>/dev/null || true)"
  [ -n "$out" ] || die "no slot '$want'. Run: scripts/bot.sh status"
  printf '%s' "$out"
}

# Sets PORT/TOKEN/RUNID/IDX for a slot, or exits.
#
# NOTE: `die` inside $( ) only kills the subshell, so a bare
# `read x <<< "$(resolve_slot ...)"` silently continues with empty values.
# Assigning first lets `set -e` see the failure and stop.
load_slot() {
  local line
  line="$(resolve_slot "$1")"
  [ -n "$line" ] || die "no slot '$1'. Run: scripts/bot.sh status"
  read -r PORT TOKEN RUNID IDX <<< "$line"
}

# Bash sees POSIX paths (/c/Users/...) but node needs a Windows path, so never
# build a file:// URL from $BOT_DIR — run from $BOT_DIR and import relatively.
step_index() {
  local want="$1"
  case "$want" in
    ''|*[!0-9]*)
      (cd "$BOT_DIR" && node -e '
        import("./dist/steps.js").then(m => {
          const i = m.STEPS.findIndex(s => s.key === process.argv[1]);
          if (i < 0) {
            console.error("no step named \"" + process.argv[1] + "\". Known steps:");
            m.STEPS.forEach((s, n) => console.error("  " + n + "  " + s.key));
            process.exit(1);
          }
          process.stdout.write(String(i));
        });' "$want") ;;
    *) printf '%s' "$want" ;;
  esac
}

print_status() {
  require_manager
  fleet_status | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const j = JSON.parse(s);
      console.log("node_id: " + (j.nodeId || "(blank)") + "  [" + (j.nodeIdSource || "?") + "]");
      console.log("");
      if (!j.slots.length) { console.log("no slots running — scripts/bot.sh start"); return; }
      // Truncate as well as pad: an overlong cell must not bleed into the next
      // column and make the whole table unreadable.
      const pad = (v, n) => {
        const t = String(v ?? "-");
        return (t.length > n - 1 ? t.slice(0, n - 1) : t).padEnd(n);
      };
      console.log(pad("SLOT",5)+pad("STATUS",12)+pad("STEP",22)+pad("ACCOUNT",26)+pad("QUIET",9)+"RUN");
      for (const s of j.slots) {
        const step = s.step ? `${s.step.index} ${s.step.key}` : "-";
        const quiet = s.lastRunnerHeartbeatAgoMs == null
          ? "-" : (s.lastRunnerHeartbeatAgoMs / 1000).toFixed(0) + "s";
        // Only add the watchdog flag when the status does not already say it.
        // (No apostrophes in here — this block lives inside a bash '...' string.)
        const status = s.stuck && !/STUCK|FAILED/.test(s.status) ? s.status + "!" : s.status;
        console.log(
          pad(s.slotIndex,5) + pad(status,12) + pad(step,22) +
          pad(s.account || "-",26) + pad(quiet,9) + s.runId,
        );
      }
      const stuck = j.slots.filter(x => x.stuck || x.status === "FAILED" || x.status === "STUCK");
      if (stuck.length) {
        console.log("");
        for (const s of stuck) console.log(`  slot ${s.slotIndex} needs attention -> scripts/bot.sh continue ${s.slotIndex}`);
      }
    });'
}

# ── commands ─────────────────────────────────────────────────────────────────

# `--id 101` anywhere in the arguments sets this node's identity for this call.
eval "$(extract_id_flag "$@")"

cmd="${1:-}"; [ $# -gt 0 ] && shift || true

case "$cmd" in

status|st)
  print_status
  ;;

watch)
  interval="${1:-3}"
  info "refreshing every ${interval}s — Ctrl-C to stop"
  while true; do
    printf '\033[H\033[2J'
    printf '%s%s%s\n\n' "$C_B" "$(date '+%H:%M:%S')" "$C_0"
    print_status || true
    sleep "$interval"
  done
  ;;

steps)
  require_build
  cd "$BOT_DIR"
  node -e '
    import("./dist/steps.js").then(m => {
      m.STEPS.forEach((s, i) => {
        const t = s.inactivityMs ? (s.inactivityMs/1000) + "s" : "unwatched";
        console.log(String(i).padStart(2) + "  " + s.key.padEnd(18) + " quiet-limit " + t);
      });
      console.log("\nresume at any of these:  scripts/bot.sh from <slot> <index|name>");
    });'
  ;;

id)
  arg="${1:-}"
  case "$arg" in
    "")
      printf 'node_id: %s (%s)\n' "$(node_id_current || echo '(unset)')" "$(node_id_source)"
      info "set it with:  ./scripts/bot.sh id 101"
      ;;
    --clear)
      rm -f "$NODE_ID_FILE"
      ok "cleared — this node will now only run rows with a blank node_id"
      ;;
    *)
      printf '%s\n' "$arg" > "$NODE_ID_FILE"
      ok "node_id set to $arg (saved in .node-id)"
      info "only Users rows with node_id $arg will run on this machine"
      info "restart the manager to pick it up:  ./scripts/kill-manager.sh && ./scripts/manager.sh --background"
      ;;
  esac
  ;;

start)
  require_manager
  n="${1:-}"
  nid="$(node_id_current || true)"
  # nodeId is no longer sent: the MASTER scopes every claim to the bot whose
  # token made the request, so naming a node here could only be wrong. The id
  # below is shown for the operator, not used for selection.
  body="{}"
  [ -n "$n" ] && body="{\"instances\":$n}"
  info "node_id: ${nid:-(blank)} ($(node_id_source))"
  out="$(api POST "$MANAGER_URL/fleet/start" -H "content-type: application/json" -d "$body")" \
    || die "start failed — the master has no runnable row for this bot.
Check with:  curl -s $MANAGER_URL/api/jobs"
  count="$(printf '%s' "$out" | json 'j.instances' || echo '?')"
  ok "started $count instance(s)"
  printf '%s' "$out" | json 'j.started.map(s => `  slot ${s.slotIndex}  row ${s.sheetRow}  ${s.account}  ${s.runId}`).join("\n")' || true
  echo
  info "watch it:  scripts/bot.sh watch"
  ;;

continue|resume)
  target="${1:?usage: bot.sh continue <slot>}"
  load_slot "$target"
  out="$(api POST "http://127.0.0.1:$PORT/resume?token=$TOKEN")" || die "resume failed for slot $IDX"
  mode="$(printf '%s' "$out" | json 'j.mode' 2>/dev/null || echo '?')"
  from="$(printf '%s' "$out" | json 'j.from' 2>/dev/null || echo '?')"
  ok "slot $IDX resuming at step $from ($mode)"
  [ "$mode" = "same-tab" ] && info "  continuing in the SAME tab — no page state lost"
  ;;

from)
  target="${1:?usage: bot.sh from <slot> <step>}"
  stepArg="${2:?usage: bot.sh from <slot> <step>}"
  step="$(step_index "$stepArg")" || exit 1
  load_slot "$target"
  out="$(api POST "http://127.0.0.1:$PORT/resume?token=$TOKEN&from=$step")" \
    || die "resume failed for slot $IDX"
  mode="$(printf '%s' "$out" | json 'j.mode' 2>/dev/null || echo '?')"
  ok "slot $IDX resuming at step $step ($mode)"
  ;;

restart)
  target="${1:?usage: bot.sh restart <slot>}"
  load_slot "$target"
  out="$(api POST "http://127.0.0.1:$PORT/resume?token=$TOKEN&from=0")" \
    || die "restart failed for slot $IDX"
  ok "slot $IDX restarting from step 0 (login) in the same browser"
  ;;

stop)
  target="${1:?usage: bot.sh stop <slot|all>}"
  if [ "$target" = "all" ]; then
    require_manager
    out="$(api POST "$MANAGER_URL/fleet/stop")" || die "stop failed"
    ok "stopped $(printf '%s' "$out" | json 'j.stopped' || echo '?') slot(s)"
  else
    load_slot "$target"
    api POST "http://127.0.0.1:$PORT/stop?token=$TOKEN" >/dev/null || die "stop failed"
    ok "slot $IDX stopped; browser preserved"
  fi
  info "${C_DIM}browsers stay open — scripts/kill-browsers.sh to close them${C_0}"
  ;;

cancel)
  target="${1:?usage: bot.sh cancel <slot>}"
  load_slot "$target"
  api POST "http://127.0.0.1:$PORT/cancel?token=$TOKEN" >/dev/null || die "cancel failed"
  ok "slot $IDX cancelled; browser closing"
  ;;

logs)
  target="${1:?usage: bot.sh logs <slot|runId> [name]}"
  name="${2:-events.ndjson}"
  runid="$target"
  if manager_up; then
    resolved="$(fleet_status | json "
      (() => { const s = j.slots.find(x => String(x.slotIndex) === '$target' || x.runId === '$target');
               return s ? s.runId : null; })()" 2>/dev/null || true)"
    [ -n "$resolved" ] && runid="$resolved"
  fi
  local_file="$BOT_DIR/artifacts/$runid/logs/$name"
  if [ -f "$local_file" ]; then
    info "${C_DIM}$local_file${C_0}"
    tail -n 50 "$local_file"
  else
    require_manager
    api GET "$MANAGER_URL/logs/$runid?name=$name" || die "no log '$name' for $runid"
  fi
  ;;

solo)
  require_build
  cd "$BOT_DIR"
  info "single bot, no manager — reading .env"
  info "${C_DIM}its control commands are printed on startup${C_0}"
  exec npm run slot
  ;;

-h|--help|help|"")
  usage
  ;;

*)
  die "unknown command: $cmd
$(usage)"
  ;;
esac
