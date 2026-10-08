#!/bin/bash
# macOS twin of cleanup.bat: kills this bot folder's leftover browsers, slots and runners.
#   ./cleanup.command            orphans (or everything when the manager is not running)
#   ./cleanup.command --all      everything, live runs included
#   ./cleanup.command --dry-run  list only
cd "$(dirname "$0")/bot" || exit 1
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
node dist/cleanup.js "$@"
echo
read -r -p "  Press Enter to close..." _
