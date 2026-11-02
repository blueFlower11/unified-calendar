#!/usr/bin/env bash
# Starts Unified Calendar in test mode on your Android phone (Termux) or any computer.
# Run it again any time: it downloads the latest version first, then starts the app.
# Then open http://localhost:3000 in Chrome. Stop with Ctrl+C.

main() {
  cd "$(dirname "$0")/.." || exit 1

  # Termux only: install Node.js the first time.
  if command -v pkg >/dev/null 2>&1 && ! command -v node >/dev/null 2>&1; then
    echo "Installing Node.js (one time, about a minute)..."
    pkg install -y nodejs || { echo "Could not install Node.js"; exit 1; }
  fi
  command -v node >/dev/null 2>&1 || { echo "Node.js 22.5 or newer is required."; exit 1; }
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)' \
    || { echo "Node.js 22.5 or newer is required (you have $(node -v))."; exit 1; }

  # Get the latest code. If this fails (offline, local changes) the current version still starts.
  if [ -d .git ] && command -v git >/dev/null 2>&1; then
    echo "Checking for updates..."
    git pull --ff-only 2>&1 | tail -2 || true
  fi

  # Termux only: keep the phone from putting the app to sleep while it runs.
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
    trap 'termux-wake-unlock 2>/dev/null' EXIT
  fi

  # Test login is safe here because the app only listens on this device.
  export HOST=127.0.0.1 PORT="${PORT:-3000}" DEV_LOGIN=1
  export DB_FILE="${DB_FILE:-$HOME/.unified-calendar/data.sqlite}"
  mkdir -p "$(dirname "$DB_FILE")"

  echo
  echo "Unified Calendar is starting."
  echo "Open this in Chrome on your phone:  http://localhost:$PORT"
  echo "Your data is kept in: $DB_FILE"
  echo
  node --no-warnings server.js
}
main "$@"
exit
