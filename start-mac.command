#!/bin/bash
# Double-click this file on macOS to run Converse from source.
# (Requires Node.js — https://nodejs.org — LTS. For a no-Node install, download
#  the .dmg from Releases instead; see INSTALL.md.)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the LTS from https://nodejs.org, then double-click again."
  read -r -n 1 -p "Press any key to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)…"
  npm install || { echo "npm install failed."; read -r -n 1; exit 1; }
fi

# Open the browser once the server is up.
( sleep 2; open "http://localhost:5173" ) &
echo "Starting Converse — the app will open in your browser. Close this window to stop."
npm start
