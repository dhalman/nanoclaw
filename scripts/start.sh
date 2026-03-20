#!/bin/bash
# Ensures Docker Desktop, ComfyUI, and OllamaDiffuser are running before starting NanoClaw.
# Safe to run multiple times — deduplicates all services before starting.

PROJECT_ROOT="/Users/lytic/software/ai/nanoclaw"
COMFYUI_PYTHON="/Users/lytic/software/ai/ComfyUI/.venv/bin/python"
COMFYUI_MAIN="/Users/lytic/software/ai/ComfyUI-src/main.py"
COMFYUI_BASE="/Users/lytic/software/ai/ComfyUI"
COMFYUI_PORT=8000
OLLAMADIFFUSER="/Users/lytic/venvs/nanoclaw/bin/ollamadiffuser"
OLLAMADIFFUSER_PORT=8001
SEARXNG_PORT=8888
SEARXNG_DIR="$PROJECT_ROOT/searxng"
LOGS_DIR="$PROJECT_ROOT/logs"
MAX_WAIT=60

mkdir -p "$LOGS_DIR"

# ---------------------------------------------------------------------------
# Kill any existing NanoClaw node process (prevents duplicates)
# ---------------------------------------------------------------------------
EXISTING=$(pgrep -f "nanoclaw/dist/index.js" 2>/dev/null || true)
if [ -n "$EXISTING" ]; then
  echo "Stopping existing NanoClaw process(es): $EXISTING"
  echo "$EXISTING" | xargs kill 2>/dev/null || true
  sleep 1
fi

# ---------------------------------------------------------------------------
# Docker
# ---------------------------------------------------------------------------
if ! docker info &>/dev/null; then
  echo "Docker not running — launching Docker Desktop..."
  open -a Docker
  waited=0
  while ! docker info &>/dev/null; do
    sleep 2
    waited=$((waited + 2))
    if [ $waited -ge $MAX_WAIT ]; then
      echo "Docker did not become ready after ${MAX_WAIT}s — starting NanoClaw anyway"
      break
    fi
  done
  [ $waited -lt $MAX_WAIT ] && echo "Docker ready after ${waited}s"
fi

# Restart Ollama and warm models (clears hung state, pins secretary + coordinator)
echo "Warming Ollama models..."
bash "$PROJECT_ROOT/scripts/warm-ollama.sh" >> "$LOGS_DIR/ollama-warmup.log" 2>&1

# Stop any leftover agent containers
ORPHANS=$(docker ps --filter name=nanoclaw- --format '{{.Names}}' 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "Stopping leftover containers: $ORPHANS"
  echo "$ORPHANS" | xargs docker stop -t 2 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# SearXNG (local metasearch)
# ---------------------------------------------------------------------------
# Generate settings.yml on first run (contains secret_key — never committed)
if [ ! -f "$SEARXNG_DIR/settings.yml" ]; then
  mkdir -p "$SEARXNG_DIR"
  SECRET=$(openssl rand -hex 32)
  cat > "$SEARXNG_DIR/settings.yml" << SEARXNG_EOF
use_default_settings: true

general:
  instance_name: "nanoclaw-search"
  privacypolicy_url: false
  donation_url: false
  contact_url: false
  enable_metrics: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "en"
  formats:
    - html
    - json

server:
  secret_key: "${SECRET}"
  limiter: false
  image_proxy: false
  method: "GET"

ui:
  default_locale: "en"
  query_in_title: false
  infinite_scroll: false
  default_theme: simple
  advanced_search: false
  static_use_hash: true

outgoing:
  request_timeout: 4.0
  max_request_timeout: 10.0
  pool_connections: 100
  pool_maxsize: 20
  enable_http2: true
SEARXNG_EOF
  echo "SearXNG settings.yml generated"
fi

if docker ps --filter name=searxng --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q searxng; then
  echo "SearXNG already running"
else
  docker rm searxng 2>/dev/null || true
  docker run -d \
    --name searxng \
    --restart unless-stopped \
    -p 127.0.0.1:${SEARXNG_PORT}:8080 \
    -v "$SEARXNG_DIR:/etc/searxng:rw" \
    searxng/searxng >> "$LOGS_DIR/searxng.log" 2>&1
  # Wait for ready
  waited=0
  while ! curl -sf http://127.0.0.1:${SEARXNG_PORT}/healthz >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if [ $waited -ge 30 ]; then echo "SearXNG startup timeout — continuing"; break; fi
  done
  [ $waited -lt 30 ] && echo "SearXNG ready after ${waited}s"
fi

# ---------------------------------------------------------------------------
# ComfyUI (headless)
# ---------------------------------------------------------------------------
if pgrep -f "ComfyUI-src/main.py" >/dev/null 2>&1 || curl -sf http://127.0.0.1:${COMFYUI_PORT}/system_stats >/dev/null 2>&1; then
  echo "ComfyUI already running"
else
  echo "Starting ComfyUI headless..."
  "$COMFYUI_PYTHON" "$COMFYUI_MAIN" \
    --base-directory "$COMFYUI_BASE" \
    --listen 127.0.0.1 --port "$COMFYUI_PORT" \
    --dont-print-server \
    >> "$LOGS_DIR/comfyui.log" 2>&1 &
  echo "ComfyUI started (pid $!)"
fi

# ---------------------------------------------------------------------------
# OllamaDiffuser
# ---------------------------------------------------------------------------
if pgrep -f "ollamadiffuser" >/dev/null 2>&1 || curl -sf http://127.0.0.1:${OLLAMADIFFUSER_PORT}/api/models >/dev/null 2>&1; then
  echo "OllamaDiffuser already running"
else
  echo "Starting OllamaDiffuser..."
  "$OLLAMADIFFUSER" --mode api --host 127.0.0.1 --port "$OLLAMADIFFUSER_PORT" \
    >> "$LOGS_DIR/ollamadiffuser.log" 2>&1 &
  echo "OllamaDiffuser started (pid $!)"
fi

# ---------------------------------------------------------------------------
# NanoClaw
# ---------------------------------------------------------------------------
cd "$PROJECT_ROOT"
echo "Building NanoClaw..."
/opt/homebrew/bin/npm run build
echo "Rebuilding agent container..."
BUILD_STATUS_FILE="$PROJECT_ROOT/.build-status.json"
if NANOCLAW_MANAGED=1 ./container/build.sh; then
  printf '{"status":"ok","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BUILD_STATUS_FILE"
else
  printf '{"status":"failed","at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$BUILD_STATUS_FILE"
  echo "WARNING: Container build failed — NanoClaw will start with stale agent image (see logs/)"
fi
# Start web console if not already running
if ! pgrep -f "ttyd.*tmux attach" >/dev/null 2>&1; then
  echo "Starting web console..."
  "$PROJECT_ROOT/scripts/web-console.sh" >> "$LOGS_DIR/web-console.log" 2>&1 &
fi

echo "Starting NanoClaw..."
exec /opt/homebrew/bin/node "$PROJECT_ROOT/dist/index.js"
