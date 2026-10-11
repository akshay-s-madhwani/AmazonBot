# Windows deployment

`setup.bat` installs the bot and global PM2, configures the deployment webhook,
starts both PM2 processes, saves them, and registers startup at Windows sign-in.
It creates `deploy.env`, generates a signing secret if missing, and prompts for
the GitHub read token when needed. Re-running setup preserves existing credentials.
No JavaScript process-management wrapper or separate ops package is needed.

## One-time setup

1. Commit the new packages workflows in the packages repo first, then commit the
   bot changes with the updated submodule reference. Preserve unrelated edits.
2. Use a clean production clone with its packages submodule initialized. Stop any
   old foreground manager, then run `setup.bat`. Node 22+, Git and Windows `tar`
   are required. Setup installs Node when needed.
3. Expose each receiver through HTTPS, forwarding only `/deploy` and `/status`
   to `127.0.0.1:7901`. Do not expose the manager or browser control ports.
4. Configure the GitHub secrets below. Merge to `main` to build and deploy.

The scheduled task runs under the setup account at sign-in. Use that same account
for PM2 and configure noninteractive Git read access to both repos. Re-run setup
after moving the checkout or changing the Node installation.

## GitHub secrets

- Bot repo `PACKAGES_READ_TOKEN`: Contents read on bot and private packages repo.
- Bot repo `DEPLOY_TARGETS`: JSON array of each machine's HTTPS URL and signing
  secret, matching `DEPLOY_SECRET` in that machine's `deploy.env`:

```json
[{ "url": "https://bot-one.example.com", "secret": "copy-the-generated-secret-from-deploy.env" }]
```

- Each machine's `DEPLOY_GITHUB_TOKEN`: Actions read on the bot repo. This is
  separate from the credentials Git uses to fetch bot and packages. Also grant
  **Pull requests: Read** when enabling PR deployments.
- Packages repo `BOT_UPDATE_TOKEN`: Contents read on packages, Contents and Pull
  requests write on bot. Optional variable `BOT_REPOSITORY` overrides its default.

Protect `main` and require build checks. Packages merges build/test packages and
open a bot submodule-update PR. Merging the bot PR builds its pinned packages and
bot, then notifies machines after success. Artifacts are retained for 30 days.

## Deploy main or choose a PR

- A successful `main` build automatically starts **Deploy bot to machines**.
  It creates an `rdp-fleet` GitHub deployment and records success/failure after
  waiting for the machines. Check this workflow as well as **Build bot**.
- To deploy a PR, open **Actions → Deploy bot to machines → Run workflow**,
  select workflow branch **main**, enter its number in **pr_number**, and run.
  Leave the field empty to deploy the latest successful build of current main.
- The PR must be open, originate in this repo, target main, and have a successful
  build of its latest head commit. Fork PRs and stale/failed builds are rejected.
  The PR is deployed to the **same machines in DEPLOY_TARGETS**, not a preview fleet.
- PR builds now upload deployable artifacts. Rerun the PR build if its previous
  run used the old workflow. A missing artifact or build fails with an explicit
  explanation rather than silently finishing without deploying.
- Merge these workflow changes to main once so GitHub registers the deployment
  trigger and manual input. GitHub only enables `workflow_run` and the manual
  Run workflow UI when their workflow exists on the default branch.
- Update/rebuild the receiver on every RDP and run `pm2 restart deploy-webhook`
  once before the first PR deployment: older receivers only accept main builds.
  Ensure its token has Pull requests read access. Restart only when no deployment
  is running. Future main deployments can replace a PR even after squash merging.

The existing HTTPS requirement still applies. Registering a deployment in GitHub
does not make an unreachable or HTTP-only receiver reachable over HTTPS.
See [GitHub workflow triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

## Daily commands

```bat
run-manager.bat
stop-manager.bat
pm2 list
pm2 logs bot-manager
pm2 logs deploy-webhook
pm2 restart bot-manager
pm2 save
```

`stop-manager.bat` asks workers to stop, stops the manager through PM2, and leaves
the webhook running. Set `MANAGER_PORT` if using a nondefault port. To disable
deployments during maintenance, `pm2 stop deploy-webhook` and `pm2 save` too.

## Deployment behavior

- Signed requests expire after five minutes. Persisted run IDs prevent duplicate
  deployments; concurrent deployments are rejected.
- The receiver verifies the successful GitHub build and exact commit, fetches
  current `main`, and checks out that revision. Production clones become detached.
- Dirty checkouts are refused. Dependencies install in staging before interruption.
  Local environment files, identity, artifacts and browser profiles are preserved.
- It waits for active jobs, closes completed idle sessions, switches files, then
  restarts the manager. Paused/stuck jobs block deployment until resolved or the
  15-minute drain timeout expires.
- Failed activation or health checks restore the previous runtime. A journal
  handles interrupted file swaps. `.deploy/history` records results.
- Notifications retry every 30 minutes for offline machines. Failed deployments
  require fixing the cause and rerunning **Build bot** for a new attempt.
- Restart the webhook separately after its own code changes, once deployment is
  finished: `pm2 restart deploy-webhook`. Do not interrupt an active deployment.
- Old `.deploy/staging` folders can be pruned during maintenance when no
  `transaction.json` exists. Never remove the active transaction's files.

This repo has no database migration command. Master/panel builds and mandatory
`npm run migrate:up` belong to the separate `AmazonManagement` repository; bot
machines do not need master database credentials.

Checks: `npm run test:deployment --prefix bot`. Startup follows
[PM2's Windows guidance](https://pm2.keymetrics.io/docs/usage/startup/), using a
Windows scheduled task for the saved process list.
