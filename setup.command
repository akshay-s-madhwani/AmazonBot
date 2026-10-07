#!/bin/bash
# Bot machine setup for macOS. Lives at the AmazonBot root, next to bot/ and
# packages/, and works from a fresh copy: no node_modules, no dist anywhere.
#   double-click setup.command          asks for the control panel URL
#   ./setup.command http://1.2.3.4      or pass it in
# The macOS twin of setup.bat — keep the two in step.

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
printf '\033]0;Bot setup\007'

pause() { echo; read -r -p "  Press Enter to close..." _; }
fail() {
  echo
  echo "  [X] Setup failed at the step above. Fix the error and run setup.command again."
  echo
  pause
  exit 1
}

echo
echo "  ==========================================================="
echo "   Bot machine setup"
echo "  ==========================================================="
echo

# ---- Apple Silicon only: the ShardX browser engine has no Intel Mac build ----
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" != "1" ]; then
  echo "  [X] This Mac has an Intel chip."
  echo
  echo "      The browser engine only runs on Apple Silicon Macs (M1 or newer)."
  echo
  pause
  exit 1
fi
echo "  [ok] Apple Silicon"

# ---- Node.js 20.6+ -- installed through nvm when missing or too old ----------
# A double-clicked script reads no shell profile, so load nvm by hand.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
load_nvm() { [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; }
node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=6)?0:1)'
}
load_nvm
if ! node_ok; then
  if command -v node >/dev/null 2>&1; then
    echo "  ... Node.js $(node -v) is too old -- installing the current LTS through nvm."
  else
    echo "  ... Node.js is not installed -- installing the current LTS through nvm."
  fi
  if ! load_nvm; then
    echo "  ... installing nvm"
    # METHOD=script: no git, so no Xcode tools prompt on a fresh Mac.
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | METHOD=script bash || fail
    load_nvm || fail
  fi
  nvm install --lts || fail
  nvm alias default 'lts/*' >/dev/null
  nvm use default >/dev/null || fail
  if ! node_ok; then
    echo "  [X] Node.js is still not usable after the install."
    fail
  fi
fi
NODE_V="$(node -v)"
# An Intel build of Node under Rosetta would ask ShardX for an Intel engine.
if [ "$(node -p process.arch)" != "arm64" ]; then
  echo "  [X] Node.js $NODE_V is the Intel build."
  echo "      Reinstall the Apple Silicon (arm64) build from https://nodejs.org/"
  echo
  pause
  exit 1
fi
echo "  [ok] Node.js $NODE_V"

# ---- the shared packages (a git submodule) -----------------------------------
if [ ! -f "packages/contracts/package.json" ] && [ -d ".git" ] && command -v git >/dev/null 2>&1; then
  echo "  ... fetching the shared packages (git submodule)"
  git submodule update --init --recursive
fi
if [ ! -f "packages/contracts/package.json" ]; then
  echo "  [X] The packages folder is missing or empty."
  echo
  echo "      Clone with:  git clone --recurse-submodules <repo>"
  echo "      or run:      git submodule update --init"
  echo "      or copy the packages folder next to bot/ and run this again."
  echo
  pause
  exit 1
fi
echo "  [ok] shared packages present"

# ---- control panel URL -> bot/.env -------------------------------------------
MASTER_URL="$1"
if [ -z "$MASTER_URL" ] && [ -f "bot/.env" ]; then
  MASTER_URL="$(grep -i '^MASTER_URL=' bot/.env | tail -n 1 | cut -d= -f2- | tr -d '\r')"
fi
if [ -z "$MASTER_URL" ]; then
  echo
  read -r -p "  Control panel URL: " MASTER_URL
fi
if [ -z "$MASTER_URL" ]; then
  echo "  [X] No control panel URL given -- nothing to join. Aborting."
  pause
  exit 1
fi
MASTER_URL="${MASTER_URL%/}"
echo "  [ok] control panel: $MASTER_URL"

if [ ! -f "bot/.env" ]; then
  if [ -f "bot/.env.example" ]; then
    cp "bot/.env.example" "bot/.env"
    echo "  [ok] created bot/.env from bot/.env.example"
  else
    : > "bot/.env"
    echo "  [ok] created an empty bot/.env"
  fi
fi
# Replace any MASTER_URL already there, so re-running with a new URL sticks.
# tr drops Windows line endings from a .env copied over from a PC.
grep -v -i '^MASTER_URL=' "bot/.env" | tr -d '\r' > "bot/.env.tmp"
echo "MASTER_URL=$MASTER_URL" >> "bot/.env.tmp"
mv -f "bot/.env.tmp" "bot/.env"
echo "  [ok] MASTER_URL written to bot/.env"

# ---- this machine's node id -> bot/.node-id -----------------------------------
# Always asked; Enter takes the machine name. This is the bot id the machine
# is approved as. A copied folder's approval for another id is discarded by
# the bot at start, and an id already in use is rejected by the master.
[ -s "bot/.node-id" ] && echo "  current node id: $(tr -d '[:space:]' < bot/.node-id)"
NODE_ID_DEFAULT="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
NODE_ID_DEFAULT="$(printf '%s' "$NODE_ID_DEFAULT" | tr '[:upper:]' '[:lower:]')"
while :; do
  echo
  read -r -p "  Node id [$NODE_ID_DEFAULT]: " NODE_ID_IN
  NODE_ID_IN="${NODE_ID_IN:-$NODE_ID_DEFAULT}"
  [[ "$NODE_ID_IN" =~ ^[A-Za-z0-9_-]{1,64}$ ]] && break
  echo "  [X] Use letters, digits, - or _ only."
done
printf '%s\n' "$NODE_ID_IN" > "bot/.node-id"
echo "  [ok] node id: $NODE_ID_IN"

# ---- install + build, in dependency order -------------------------------------
build_pkg() {
  echo "  --- $2 ---"
  ( cd "$1" && npm install --no-audit --no-fund && npm run build ) || return 1
  echo "  [ok] $2 built"
}

echo
echo "  Installing dependencies (this takes a few minutes the first time)..."
echo
build_pkg "packages/contracts" "shared contracts" || fail
build_pkg "packages/transport" "transport"        || fail
build_pkg "bot"                "bot"              || fail

echo
echo "  --- ShardX browser engine ---"
( cd bot && node dist/install-browser.js ) || fail
mkdir -p "bot/browser-profiles"
echo "  [ok] profile store: $ROOT/bot/browser-profiles"

cat > "start.command" <<'EOF'
#!/bin/bash
cd "$(dirname "$0")/bot" || exit 1
printf '\033]0;Bot\007'
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
open http://127.0.0.1:7800
node dist/manager.js
echo
read -r -p "  Press Enter to close..." _
EOF
chmod +x "start.command" "run-manager.command" "stop-manager.command" 2>/dev/null
echo "  [ok] created start.command for future starts"

echo
echo "  ==========================================================="
echo "   Setup complete. Starting the bot."
echo
echo "   It will print a SHORT ID below, and open its own console"
echo "   at http://127.0.0.1:7800 which shows the same id."
echo
echo "   In the control panel, open Machines and approve the"
echo "   machine with that id. Until then the bot waits -- normal."
echo "  ==========================================================="
echo

open http://127.0.0.1:7800
cd bot && node dist/manager.js
echo
echo "  The bot has stopped. Run start.command to start it again."
pause
exit 0
