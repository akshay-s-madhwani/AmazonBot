# amazon-login-bot

Amazon automation using **ShardX**, with a fresh browser profile for every run and
a separate slot process owning each browser. Fleet jobs come from the master;
standalone diagnostics can read configuration from env. The ordered pipeline is:

0. **login** — email → password → TOTP OTP → skip passkey nudge.
1. **check_reward** — SOP step 3: collect anything owed *before* shopping, so it
   applies to this order. Handles the **Collect Now** and **Spin** rewards;
   detects the **Sticker Challenge** and defers it (it needs items added between
   refreshes). **Never blocks the order** — no reward, already redeemed, or
   deferred all report `skipped` and the run continues.
2. **set_address** — on `/a/addresses`, verify the target address if it's
   already the default, set it as default if it exists but isn't, or add a new
   address (all mandatory fields) if none match.
3. **clear_cart** — SOP step 5: empty the cart **before touching any product**,
   so nothing left over is bought alongside this order.
4. **add_items** — for **each item** of this user: open the listing, select the
   purchase option, set quantity, apply any coupon, add to cart. Re-empties the
   cart first, so a retry cannot double-add.
5. **proceed_to_buy** — SOP step 6.
6. **select_address** — SOP step 7; requires one unambiguous PIN match and the requested address line.
7. **select_payment** — SOP step 8: Amazon Pay balance / voucher codes.
8. **confirm_order** — SOP step 9. ⚠ **Places the order.** See below.
9. **note_order_id** — SOP step 10: records the `NNN-NNNNNNN-NNNNNNN` id to
   `artifacts/<run-id>/order-id.txt` and flags a cancelled order.

The number **is** the resume address: `/resume?token=…&from=7` restarts at
`select_payment`. Inserting a step renumbers everything after it.

If a listing can't offer the requested quantity, the run **stops and says so**
rather than ordering a different amount — see *Resuming after a config change*.

## Driving it — the scripts

Day to day you do not call these endpoints by hand. Four Git Bash scripts wrap
them; see **[scripts/README.md](scripts/README.md)** for the full guide.

```bash
./scripts/manager.sh --background   # start the manager
./scripts/bot.sh start 2            # start 2 bots from the sheet
./scripts/bot.sh status             # what is each one doing
./scripts/bot.sh continue 0         # after fixing a sheet cell
./scripts/kill-browsers.sh --list   # what browsers are open
```

### Product types

All four supported types reduce to Amazon's accordion buy box, confirmed live:

| Type | Buy box |
| --- | --- |
| Normal (Prime) | no accordion rows |
| Amazon Fresh | `almAccordionRow` (active by default) + `newAccordionRow_*` |
| Regular + coupon | no accordion; checkbox in `#promoPriceBlockMessage_feature_div` |
| Subscribe & Save | `newAccordionRow_0` + `snsAccordionRowMiddle` (+ frequency rows) |

`PRODUCT_PURCHASE_OPTION` controls the choice: `auto` (default) takes
**Subscribe & Save when offered**, otherwise Amazon's own default row; coupons
are always applied when present. Force a specific row with `subscribe_save`,
`one_time`, or `fresh` — those fail loudly if the listing doesn't offer them.

## Fleet mode (`npm start` / `npm run manager`) — the independent unit

Three tiers, all local. No NATS, no SQLite, no master.

```
MANAGER (Express :7800)      asks the MASTER for jobs, runs N instances, owns the watchdog, captures logs
   │ spawns N
SLOT (ephemeral port)        owns one ShardX browser + browser activity monitoring
   │ spawns (fire-and-forget)
RUNNER (one per run)         Playwright; job comes from the master (JOB_ID)
```

```sh
npm run manager
curl -X POST http://127.0.0.1:7800/fleet/start     # instances + jobs from the sheet
curl http://127.0.0.1:7800/fleet/status            # per-slot step, idle times, STUCK flags
curl -X POST http://127.0.0.1:7800/fleet/stop
curl "http://127.0.0.1:7800/logs/<runId>?name=events.ndjson"
```

**How many instances** comes from the sheet's `Config` tab (`instances` key), which the
manager reads through the master (`GET /node/config`). Each instance takes its own row, so
**every row must use a different Amazon account** — two concurrent runs on one account make
Amazon reject the second login ("There was a problem").

### The local console

The manager serves a UI of its own at **http://127.0.0.1:7800** (`bot/ui`, three
plain files — no build step, no network). It is the answer to "the control panel
cannot see this machine and I am standing in front of it":

| It shows | It does |
|---|---|
| the enrollment short id, while the machine waits to be approved | start N jobs from the sheet |
| bot id, fleet link state, slots advertised, draining | continue a slot, or resume it at any step |
| every slot: account, run id, step position, quiet timer vs that step's watchdog limit | end a run (the browser stays open) |
| the sheet rows addressed to this machine | read a run's event log |

It binds to `127.0.0.1` only, which is why it has no login: "local" is enforced
by the socket, not by a password nobody would rotate.

The step track on each slot card is clickable — every segment is a resume
address, so jumping back to `select_payment` is one click rather than a curl
with a token in it.

### Setting up a new machine

Copy this folder and `../packages` onto the machine and run **[`setup.bat`](setup.bat)**:

```
setup.bat                        REM asks for the control panel URL
setup.bat http://1.2.3.4:8080    REM or pass it in
```

It checks Node.js, writes `MASTER_URL` into `.env`, installs and builds the two
shared packages and this one, downloads the ShardX browser engine, creates the
per-account profile store, writes a `start.bat` for future starts, and launches
the bot.

**macOS** (Apple Silicon only — ShardX has no Intel Mac build): double-click
[`setup.command`](../setup.command) at the AmazonBot root, or run
`./setup.command http://1.2.3.4:8080`. It does the same steps and writes a
`start.command`; [`run-manager.command`](../run-manager.command) and
[`stop-manager.command`](../stop-manager.command) mirror the `.bat` pair. A copy
that did not come through git (zip, AirDrop) loses the run permission and
gets quarantined — fix both once with
`chmod +x *.command && xattr -dr com.apple.quarantine .` in that folder.
On macOS the engine installs to `~/Library/Application Support/shardx-sdk`.

The engine is a few hundred MB and installs to `%LOCALAPPDATA%\shardx-sdk`, so
it is shared by every clone on the machine and survives a re-clone. The profile
store is `browser-profiles/` **inside this folder**. Every run gets its own newly
minted profile (`run-<hash of the run id>`: new fingerprint, empty cookies), so
every run signs in from scratch; a browser relaunched for the same run gets that
run's profile back. Run profiles unused for `SHARDX_PROFILE_TTL_HOURS` (default
24) are deleted at the next launch. Older per-account `acct-*` folders are no
longer used and can be deleted by hand.

Slow machines: the login waits can be raised in `.env` with `LOGIN_STEP_WAIT_MS`
(45s), `LOGIN_NAV_TIMEOUT_MS` (45s), `LOGIN_TIMEOUT_MS` (200s) and
`LOGIN_FINAL_CHECK_MS` (30s).

Nothing else is configured on the machine. No token, no password, no node id.

### Joining the fleet

On its first start the bot generates a random secret, derives an eight-character
**short id** from it, and announces itself to the control panel — hostname, os,
version — over plain HTTP. Then it waits, printing that short id:

```
[enroll] this machine is not part of the fleet yet.
[enroll]   short id:  K7F2-9QX3
[enroll]   machine:   WIN-DESK-07
[enroll]   master:    http://203.0.113.10:8080
[enroll] approve it in the control panel (Bot Grid) — waiting...
```

In the panel, the header shows *"1 bot waiting to join"*. **Bot Grid** lists the
request with the machine name, the IP the master observed, and the short id.
Match that short id against the console above, set the bot id (prefilled from
the hostname — this is the value the sheet's `node_id` column must match), and
approve. Within five seconds the bot has its credentials and is in the grid.

The secret never leaves this machine: the master keeps only its hash, and both
sides derive the short id the same way, so what the operator approves is
provably this machine.

Two files hold the result, both gitignored:

| File | What |
|---|---|
| `.bot-identity.json` | the secret and short id. Delete it to ask again as a new machine. |
| `.fleet-credentials.json` | bot id, API token, NATS coordinates. Delete it to re-enroll. |

Once joined, [`src/fleet.ts`](src/fleet.ts) dials **out** to the master, registers, heartbeats
every 5s, streams step telemetry through a crash-safe on-disk outbox, pushes
each per-step screenshot to `POST /artifacts`, and accepts commands
(`start_job`, `resume`, `restart_from_step`, `cancel`, `close_session`,
`capture_artifacts`, `drain`, `update_config`) from the control panel.

The master owns Google credentials, sheet ingestion and the purchase ledger. It
sends only this node's assigned jobs over its authenticated API. Telemetry contains
redacted summaries. Initial NATS failures retry with backoff while events persist
in the local outbox. Pause finishes the current step; Stop terminates the runner
and parks its browser; Cancel closes the browser. Open browser restores a parked
session without running any steps.

Leave `MASTER_URL` unset and none of this happens: no enrollment, no telemetry,
no remote control, identical behaviour to a standalone bot. See the FLEET LINK
block in [.env.example](.env.example).

### Sheet layout — three tabs

An order is **many items for one user**, so users and items are separate tabs joined on
`user_id`:

| Tab | One row per | Key columns |
| --- | --- | --- |
| `Sheet1` (Users) | user / order | `status`, **`user_id`**, `account_*`, `address_*`, `payment_method`, `payment_codes`, the written-back `order_id` / `order_placed_at` / `notes`, and **`node_id`** |
| `Items` | **item** | **`user_id`**, `product_url`, `quantity`, `purchase_option`, `apply_coupon`, `price`, `notes` |
| `Config` | setting | `instances` |

**`node_id` (Users, column S)** decides which machine runs the row. A machine
runs a row only when its own id matches exactly — blank matches blank, and
there is no "unassigned" fallback, so two machines can never race for one row.
Set a machine's identity with `./scripts/bot.sh id 101`; see
[scripts/README.md](scripts/README.md#node-identity--which-rows-this-machine-runs).

> Column order is the contract — the code reads by position, so **append new
> columns at the end only**.

Every `Items` row whose `user_id` matches a user is added to that user's single cart. A
user row with no matching items is skipped with a warning rather than run empty.

The master reads all three tabs and mirrors them into Postgres; this machine never opens
the spreadsheet. `curl 127.0.0.1:7800/api/jobs` shows the rows the master says are this
bot's, with secrets already redacted.

### Inactivity watchdog

Two signals, correlated by the manager:

- the **slot** samples browser activity through CDP independently of the runner;
- the **runner** heartbeats which step is live — it stops when the process dies.

A run is flagged only when **both** have been quiet longer than that step's own
`inactivityMs` in [src/steps.ts](src/steps.ts). There is **no global default**: a step
without a value is deliberately un-watched, because a wrong threshold causes false STUCK
flags, which are worse than a slow step. On trip the manager logs `watchdog.inactive`,
marks the run `STUCK`, and **leaves the browser alive** for inspection and resume.

### Logs

Per run, under `artifacts/<runId>/logs/`:

| File | Contents |
| --- | --- |
| `events.ndjson` | structured events, one JSON per line — what reporting will consume |
| `runner.log` | Playwright stdout + stderr |
| `browser.log` | the ShardX process's own output |
| `slot.log` | the slot process |

## Resuming after a config change

Start and Resume read the latest sheet inputs. Changed products or quantities
rebuild the cart; changed address/payment inputs revisit the affected steps.
Account or node changes queue a fresh attempt and close the old browser.
Open browser restores the original session without running steps.

To buy again, set PENDING or use **New attempt (PENDING)** in either control panel.
An active/parked session holds the retry until it closes. Resume continues that
session; Cancel/Close session lets the next attempt proceed. The previous runner
must stop before a replacement starts.

## Payment

Exactly two methods, set per user row:

| `payment_method` | `payment_codes` | Meaning |
| --- | --- | --- |
| `voucher` | `SVDEE8XBMBF4X` | A shopping voucher applied at checkout |
| `amazon_pay` | `CODE1:71, CODE2:98` | One or more codes redeemed to Amazon Pay balance, then paid from balance. The `:amount` suffix is optional and informational — several codes can be needed to cover one total. |

Both are redeemed through the checkout's "Enter Code / Apply" field and then paid
from the resulting balance.

> **Codes are single-use.** Redeeming one consumes it, and a failed order does
> not give it back. So `select_payment` is a **DRY RUN by default**: it reports
> the order total, the balance row and the codes it *would* redeem, then stops.
> Set `PAYMENT_APPLY_CODES=true` in `bot/.env` only once you've checked the
> numbers add up, then resume.

## ⚠ Placing orders

`confirm_order` **places a real order and spends real money.** Purchase history
is recorded per attempt (`run_id`). Repeated commands cannot submit the same
attempt twice, but PENDING or New attempt authorizes another purchase on the
same row. Old order IDs never prohibit a new attempt. The local JSON is a cache.

Before clicking, the basket and delivery address must match. A reported success
needs matching order evidence. Uncertainty is shown in the interfaces; the user
can authorize another attempt. See [local operation](../SAFETY-ROLLOUT.md).

The login logic is ported from the Chrome extension that automated the same flow
(same selectors, the `form.submit()` trick that dodges Amazon's WebAuthn click
interception, and the step detection), collapsed into one linear
detect→handle loop because Playwright holds a persistent page.

## Setup

```sh
cd bot
npm install
npm run fetch-browser      # one-time: downloads the ShardX runtime
cp .env.example .env        # then fill in AMAZON_EMAIL / AMAZON_PASSWORD / AMAZON_TOTP_SECRET
```

`.env` (loaded automatically via Node's built-in `process.loadEnvFile` — no
dotenv library):

| Var                  | Required | Notes                                        |
| -------------------- | -------- | -------------------------------------------- |
| `AMAZON_EMAIL`       | yes      | Account email                                |
| `AMAZON_PASSWORD`    | yes      | Account password                             |
| `AMAZON_TOTP_SECRET` | no       | Base32 2FA secret (spaces stripped); needed only if 2FA is on |
| `BROWSER_HEADLESS`   | no       | `true`/`false`, default `false` (headful)    |
| `ADDRESS_NAME` / `ADDRESS_PHONE` / `ADDRESS_PINCODE` / `ADDRESS_LINE1` / `ADDRESS_CITY` / `ADDRESS_STATE` | yes | Mandatory delivery-address fields |
| `ADDRESS_LINE2` | *effectively yes* | "Area, Street, Sector, Village" — nominally optional, but Amazon.in rejects addresses without it ("unable to verify the street address") |
| `ADDRESS_LANDMARK` / `ADDRESS_COUNTRY` | no | Optional (country defaults to `India`) |
| `PRODUCT_URL` | yes | Full `amazon.in` URL or short `amzn.in/d/...` link |
| `PRODUCT_QUANTITY` | no | Positive integer, default `1` |
| `PRODUCT_PURCHASE_OPTION` | no | `auto` (default) / `subscribe_save` / `one_time` / `fresh` |
| `PAYMENT_APPLY_CODES` | no | `true` to actually redeem payment codes. **Default off** (dry run) because codes are single-use |

`ADDRESS_CITY` and `ADDRESS_STATE` are only a **fallback**: Amazon auto-fills
city/state from the PIN code and overwriting its canonical spelling makes it
reject the address with "Please enter a valid city".

## Run

### Two-component mode (`npm run slot`) — the real architecture

Two processes, deliberately decoupled. **No SQLite, no NATS, no agent** — this is
the local prototype of the fleet's slot + runner tiers (see
[Node-Execution-Design.MD](../Node-Execution-Design.MD)).

| Component | File | Owns | Lifetime |
| --- | --- | --- | --- |
| **Slot manager** | `src/slot.ts` | The **browser** (`launchServer` → `wsEndpoint`) + step records + HTTP control | Long-lived |
| **Playwright runner** | `src/runner.ts` | The **context/page**, executes steps | One process per run, **disposable** |

```sh
npm run slot
```

The slot launches ShardX, spawns the runner **detached and fire-and-forget**, and
records each step transition. The key property:

> **If the runner crashes, hangs or is killed, the browser stays alive and the slot
> keeps its lock.** Nothing is thrown away — you resume against the same browser.

On failure the slot prints its control commands:

```sh
curl "http://127.0.0.1:7801/status?token=$TOKEN"                 # step-by-step state
curl -X POST "http://127.0.0.1:7801/resume?token=$TOKEN"         # continue where it stopped
curl -X POST "http://127.0.0.1:7801/resume?token=$TOKEN&from=1"  # jump to a step
curl -X POST "http://127.0.0.1:7801/resume?token=$TOKEN&from=0"  # restart all steps
curl -X POST "http://127.0.0.1:7801/cancel?token=$TOKEN"         # close browser, release slot
```

The browser is closed **only** when the last step succeeds, or on cancel/Ctrl-C — a
failed or stuck run keeps it open on the failed page. Cookies are checkpointed to
`artifacts/<run-id>/storage-state.json` after login, so a respawned runner skips the OTP.
Every step is screenshotted to `artifacts/<run-id>/` (proactively — if the runner is
hard-killed, its context dies with it and nothing can be captured afterwards).

### Single-process mode (`npm run single`) — legacy harness

```sh
npm run single   # one process: launch ShardX → login → address → close
```

Simpler for iterating on step logic; loses the browser on any failure. This is
the only mode that reads `AMAZON_EMAIL` / `AMAZON_PASSWORD` (and the product /
address vars) from `.env`. Fleet mode takes every account from the master.

## Test

```sh
npm run test:totp     # verifies the TOTP generator against RFC-6238 vectors (no browser)
npm run test:fleet    # redaction + job-summary checks (no browser, no network)

# with a live nats-server -js, the same command also runs a full round-trip
# against a FAKE MASTER: register, heartbeat, telemetry over JetStream, and
# every command answered — the only way to prove the wire shapes match.
NATS_URL=nats://127.0.0.1:4222 npm run test:fleet
```

The real end-to-end test is a live `npm run single` — watch the headful window walk
the login and confirm success. The selectors are ported from the extension's
live-confirmed notes; if Amazon's DOM has drifted, fix `src/selectors.ts` and
re-run.

## Layout

- `src/config.ts` — env load + validation (`loadConfig`, `loadAddress`)
- `src/totp.ts` — RFC-6238 TOTP (Node `crypto`, no external lib)
- `src/selectors.ts` — ported login selector map + ordered `firstLocator`
- `src/login.ts` — the detect→handle login loop
- `src/address.ts` — the Add Address step (verify / set-default / add)
- `src/product.ts` — buy-box steps (open_product / set_quantity / apply_coupon)
- `src/steps.ts` — the ordered step registry
- `src/protocol.ts` — slot ↔ runner types and helpers
- `src/index.ts` — launch ShardX → login → address → close
