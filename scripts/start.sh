#!/bin/bash
# Start NanoClaw STAGING instance
# Launches shared backends (idempotent), then starts the staging Node process.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTANCE_DIR="$PROJECT_ROOT/stage"
LOGS_DIR="$INSTANCE_DIR/logs"

mkdir -p "$LOGS_DIR" "$INSTANCE_DIR/store" "$INSTANCE_DIR/data" "$INSTANCE_DIR/groups"

# Log rotation
for logfile in "$LOGS_DIR/nanoclaw.log" "$LOGS_DIR/nanoclaw.error.log"; do
  if [ -f "$logfile" ]; then
    size=$(stat -f%z "$logfile" 2>/dev/null || echo 0)
    if [ "$size" -gt 5242880 ]; then
      [ -f "${logfile}.2" ] && rm "${logfile}.2"
      [ -f "${logfile}.1" ] && mv "${logfile}.1" "${logfile}.2"
      mv "$logfile" "${logfile}.1"
    fi
  fi
done

# Kill leftover staging containers (don't touch live)
ORPHANS=$(docker ps --filter name=nanoclaw-staging- --format '{{.Names}}' 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "Stopping leftover staging containers: $ORPHANS"
  echo "$ORPHANS" | xargs docker stop -t 2 2>/dev/null || true
fi

# Start shared backends (idempotent)
"$SCRIPT_DIR/start-backends.sh"

cd "$PROJECT_ROOT"

# Load environment and set instance paths
set -a
source "$INSTANCE_DIR/.env"
set +a
export STORE_DIR="$INSTANCE_DIR/store"
export DATA_DIR="$INSTANCE_DIR/data"
export GROUPS_DIR="$INSTANCE_DIR/groups"
export NANOCLAW_INSTANCE=staging

# Compile TypeScript as safety net
echo "Compiling TypeScript..."
/opt/homebrew/bin/npm run build

# Rebuild native modules if needed
/opt/homebrew/bin/node -e "require('better-sqlite3')" 2>/dev/null || {
  echo "Rebuilding native modules..."
  PATH="/opt/homebrew/bin:$PATH" /opt/homebrew/bin/npm rebuild better-sqlite3
}

# Web console
if ! pgrep -f "ttyd.*tmux attach" >/dev/null 2>&1; then
  [ -f "$SCRIPT_DIR/web-console.sh" ] && "$SCRIPT_DIR/web-console.sh" >> "$LOGS_DIR/web-console.log" 2>&1 &
fi

echo "Starting NanoClaw (staging)..."
exec /opt/homebrew/bin/node "$PROJECT_ROOT/dist/index.js"
