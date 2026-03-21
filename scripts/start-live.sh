#!/bin/bash
# Start NanoClaw LIVE instance
# Shares Docker, Ollama, SearXNG, ComfyUI, OllamaDiffuser with staging.
# Has its own .env, data dir, store, logs, and registered groups.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTANCE_DIR="$PROJECT_ROOT/live"
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

# Kill leftover live containers (don't touch staging)
ORPHANS=$(docker ps --filter name=nanoclaw-live- --format '{{.Names}}' 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "Stopping leftover live containers: $ORPHANS"
  echo "$ORPHANS" | xargs docker stop -t 2 2>/dev/null || true
fi

cd "$PROJECT_ROOT"

# Load live .env and set instance paths
set -a
source "$INSTANCE_DIR/.env"
set +a
export STORE_DIR="$INSTANCE_DIR/store"
export DATA_DIR="$INSTANCE_DIR/data"
export GROUPS_DIR="$INSTANCE_DIR/groups"

echo "Starting NanoClaw LIVE..."
exec /opt/homebrew/bin/node "$PROJECT_ROOT/dist/index.js"
