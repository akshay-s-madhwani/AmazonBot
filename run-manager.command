#!/bin/bash
# macOS twin of run-manager.bat.
cd "$(dirname "$0")/bot" || exit 1
printf '\033]0;Bot manager\007'
open http://127.0.0.1:7800
node dist/manager.js
echo
read -r -p "  Press Enter to close..." _
