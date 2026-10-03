# Bot utility scripts

Six Bash scripts for driving the bot on Windows. They run in **Git Bash**
(bundled with Git for Windows) — not `cmd.exe` or PowerShell.

```bash
cd bot
chmod +x scripts/*.sh      # once, after cloning
./scripts/bot.sh status
```

| Script | Purpose |
|---|---|
| [`bot.sh`](bot.sh) | Control the bots — start, continue, resume at a step, restart, stop, logs |
| [`manager.sh`](manager.sh) | Start the fleet manager |
| [`kill-manager.sh`](kill-manager.sh) | Stop the fleet manager |
| [`kill-browsers.sh`](kill-browsers.sh) | Close bot-owned ShardX browsers, by slot or all |

| [`_lib.sh`](_lib.sh) | Shared helpers sourced by the other scripts |

Executable scripts take `--help`; `_lib.sh` is a library. `browser-roots.ps1` uses
CIM to find bot browser roots, excluding ordinary Chrome.

---

## Node identity — which rows this machine runs

One sheet drives many machines. Each machine has a **node id**, and it runs
**only** the Users rows whose `node_id` column matches.

```bash
./scripts/bot.sh id            # what am I?
./scripts/bot.sh id 101        # become node 101 (saved in .node-id)
./scripts/bot.sh id --clear    # back to unset
```

Run as a different node just for one command with `--id`:

```bash
./scripts/bot.sh --id 100 start     # run node 100's rows this once
./scripts/manager.sh --id 101       # start the manager as node 101
```

**Precedence:** `--id` flag → `NODE_ID` env → `.node-id` file → unset.

### The matching rule

> A row runs on this machine **iff** `Users.node_id` equals this machine's id.
> Blank matches blank.

Exact, both ways. A node with id `101` runs *only* rows marked `101` — it will
not touch blank rows. A node with no id runs *only* blank rows.

There is deliberately **no** "unassigned rows are fair game" fallback. With many
machines polling one sheet, that would mean two nodes racing for the same row —
and the loser logs into an account that is not theirs and spends its balance.

When nothing matches, the reason is spelled out rather than left as a blank
"nothing to do":

```
[sheet] no rows for node "100" — 1 pending row(s) belong to node_id: 101
```

### Setting it up

1. The Users tab has a **`node_id`** column (column **S**, appended after
   `notes`). Fill it with the id of the machine that should run each row.
2. On each machine, `./scripts/bot.sh id <n>` once.
3. Restart the manager so it picks the id up.

`.node-id` is gitignored — if it were committed, every machine cloning the repo
would inherit the same identity.

Check what this machine has been given, without running anything. The master
decides — it only ever returns rows whose `node_id` matches this bot:

```bash
curl -s 127.0.0.1:7800/api/jobs | jq        # this node's pending rows
curl -s "$MASTER_URL/sheet/status" | jq     # when the mirror last refreshed
```

---

## The one thing to understand first

**Browsers deliberately outlive everything else.** The manager can die, the
runner can crash, you can close the terminal — the browser stays open with its
logged-in session intact. That is the whole point of the design, and it is why
there is a *separate* script for killing browsers.

The consequence: **nothing here closes a browser unless you ask it to.**
Stopping the manager leaves browsers running. Cancelling a run leaves the
browser running. When you are done, `kill-browsers.sh` is a deliberate step.

---

## Daily flow

```bash
./scripts/bot.sh id 101                # 0. once per machine — who am I
./scripts/manager.sh --background      # 1. start the manager
./scripts/bot.sh start 2               # 2. start 2 of node 101's rows
./scripts/bot.sh watch                 # 3. watch them work
                                       # 4. a step fails -> fix the sheet cell
./scripts/bot.sh continue 0            # 5. carry on in the same tab
./scripts/kill-browsers.sh all         # 6. close the browsers when done
./scripts/kill-manager.sh              # 7. stop the manager
```

---

## `bot.sh` — the control CLI

```
./scripts/bot.sh id [n]              show or set this machine's node_id
./scripts/bot.sh status              what every slot is doing right now
./scripts/bot.sh steps               the step list with its resume indices
./scripts/bot.sh start [n]           start n instances from the sheet
./scripts/bot.sh continue <slot>     resume a stuck slot at the step it failed
./scripts/bot.sh from <slot> <step>  resume at a specific step
./scripts/bot.sh restart <slot>      re-run from step 0 in the same browser
./scripts/bot.sh stop <slot|all>     end the run (browser stays open)
./scripts/bot.sh logs <slot|runId>   tail this run's structured events
./scripts/bot.sh watch [seconds]     live status, refreshing
./scripts/bot.sh solo                one bot, no manager (uses .env)
```

`<slot>` is a slot index (`0`, `1`, …) **or** a run id.

### `status`

```
SLOT STATUS      STEP                  ACCOUNT                   QUIET    RUN
0    STUCK       4 add_items           nishak@turnmail.store     4s       run-1786268526340-0

  slot 0 needs attention -> scripts/bot.sh continue 0
```

`QUIET` is how long since the runner's last heartbeat. A number climbing past
that step's limit (see `steps`) is what trips the watchdog. A `!` after the
status means the watchdog flagged it.

### `continue` — the fix-and-resume loop

This is the command you will use most. A step fails, the run **parks with the
browser open**, and the reason plus the exact cell to change is written to the
sheet. You fix the cell, then:

```bash
./scripts/bot.sh continue 0
# slot 0 resuming at step 4 (same-tab)
#   continuing in the SAME tab — no page state lost
```

`same-tab` means the original runner was still holding its tab, so nothing was
lost — same process, same page, same cart. The config is **re-read from the
sheet** on every resume, and completed steps are never re-run.

If it says `new-runner` instead, the old runner was gone and a fresh one
started in the same browser. Cookies survive; page state does not.

### `from` — resume at a specific step

Takes an index or a step name:

```bash
./scripts/bot.sh from 0 select_payment
./scripts/bot.sh from 0 7               # the same thing
```

**When you need this:** if a run fails at `confirm_order` complaining the
payment was not applied, resuming *there* can never work — the payment was
applied in a browser session that no longer exists. Go back a step:

```bash
./scripts/bot.sh from 0 select_payment
```

A wrong name prints the whole list, so you cannot guess wrong for long.

### `restart` and `stop`

```bash
./scripts/bot.sh restart 0     # from step 0 (login), same browser
./scripts/bot.sh stop 0        # park this run; browser stays open
./scripts/bot.sh stop all      # park every run; browsers stay open
./scripts/bot.sh cancel 0      # cancel and close this browser
```

### `logs`

```bash
./scripts/bot.sh logs 0                      # last 50 structured events
./scripts/bot.sh logs 0 runner.log           # the runner's stdout/stderr
./scripts/bot.sh logs 0 browser.log          # ShardX's own output
./scripts/bot.sh logs run-1786268526340-0    # by run id
```

Reads `artifacts/<runId>/` directly when present, otherwise asks the manager.
Available names: `events.ndjson` (default), `slot.log`, `runner.log`,
`browser.log`.

### `solo` — one bot, no manager

Runs a single slot straight from `.env`, no sheet and no manager. Useful for
testing one account. It prints its own control URLs on startup.

---

## `manager.sh` — start the manager

```bash
./scripts/manager.sh                 # foreground, Ctrl-C to stop
./scripts/manager.sh --background    # detached; logs to artifacts/manager.log
./scripts/manager.sh --port 7900     # a different port
./scripts/manager.sh --build         # force a rebuild first
```

Builds automatically if `dist/` is missing. **Refuses to start a second manager
on a port that already has one** — a stale manager quietly serving requests has
cost real debugging time before.

---

## `kill-manager.sh` — stop the manager

```bash
./scripts/kill-manager.sh              # stop slots, then the manager
./scripts/kill-manager.sh --hard       # skip the graceful stop
./scripts/kill-manager.sh --port 7900
```

Asks the manager to stop its slots first so they do not linger as orphans, then
kills it. Safe to run twice.

> On Windows, `pkill -f dist/manager.js` **does not work**. The manager is found
> by whoever is LISTENING on its port. That is what this script does.

Browsers are left running — that is deliberate.

---

## `kill-browsers.sh` — close browsers

```bash
./scripts/kill-browsers.sh --list          show every browser, owned + unowned
./scripts/kill-browsers.sh 0               close slot 0's browser
./scripts/kill-browsers.sh run-1786...-0   close that run's browser
./scripts/kill-browsers.sh all             close every browser the manager owns
./scripts/kill-browsers.sh --orphans       close browsers no live slot owns
./scripts/kill-browsers.sh --really-all    close EVERY bot browser on this machine
```

Add `--dry-run` to see what would happen, `--yes` to skip the prompt.

### Why this one is fussy

A browser you parked by hand looks **exactly** like a bot browser to
`taskkill /IM chrome.exe`. A blanket kill has already destroyed a
hand-parked session once during development. So:

- `all` means *every browser the manager currently owns* — never a blanket kill.
- `--orphans` is the one you want after a crash: browsers left behind by a fleet
  that is no longer running. During testing, orphans once reached enough
  processes to trigger an out-of-memory crash, so check for them periodically.
- `--really-all` is the blanket option. It warns, and requires you to type
  `yes`.

### One browser is many processes

```
$ ./scripts/kill-browsers.sh --list
browsers  1 root process(es), 1 bot browser root(s) total
```

Each browser runs a root process plus content children, so **8 processes here is one
browser**. Do not read the process count in Task Manager as a browser count.
The script works on root processes and kills each as a tree.

If the manager is down, ownership is unknowable and every browser shows as
unowned — the script says so before doing anything.

---

## Troubleshooting

**`manager is not running`** — start it: `./scripts/manager.sh --background`.

**`the master has no runnable rows for this bot`** — the rows exist but belong
to another machine, or this machine's id is wrong. `./scripts/bot.sh id` to see
who you are, and `curl -s 127.0.0.1:7800/api/jobs` for what the master says is
yours. A row also needs at least one `Items` row and a `status` that is not
`DONE`/`RUNNING` — clear the status cell to re-run a row (the master adopts a
cell you changed to `PENDING`, but never one that is already `RUNNING`).

**The manager ignores an id you just set.** The manager reads its identity at
startup. Restart it, or pass the id per-command with `./scripts/bot.sh --id N
start`, which always overrides whatever the manager holds.

**`a manager is ALREADY running`** — one is up. `./scripts/bot.sh status` to see
it, or `./scripts/kill-manager.sh` to replace it.

**A slot shows an old step number.** A running slot has its step list baked in
from when it started. If steps were added since, resume indices for *that* slot
follow its own list — check `./scripts/bot.sh steps` against the slot's age, and
restart the slot to pick up a new list.

**Scripts fail with `\r: command not found`.** The files were checked out with
CRLF endings. Fix with `sed -i 's/\r$//' scripts/*.sh`.

**`Permission denied`** — `chmod +x scripts/*.sh`.
