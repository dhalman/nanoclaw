#!/bin/bash
# Start/restart a backend service. Called by nanoclaw IPC task handler.
# Usage: manage-service.sh <service> [start|restart]
#
# Services: searxng, comfyui, ollamadiffuser, ollama

set -e
SERVICE="$1"
ACTION="${2:-start}"
PROJECT_ROOT="/Users/lytic/software/ai/nanoclaw"
LOGS_DIR="$PROJECT_ROOT/logs"

mkdir -p "$LOGS_DIR"

case "$SERVICE" in
  searxng)
    if [ "$ACTION" = "restart" ]; then
      docker stop searxng 2>/dev/null || true
      docker rm searxng 2>/dev/null || true
    fi
    if docker ps --filter name=searxng --filter status=running --format '{{.Names}}' 2>/dev/null | grep -q searxng; then
      echo "SearXNG already running"
      exit 0
    fi
    docker rm searxng 2>/dev/null || true
    docker run -d --name searxng --restart unless-stopped \
      -p 127.0.0.1:8888:8080 \
      -v "$PROJECT_ROOT/searxng:/etc/searxng:rw" \
      searxng/searxng >> "$LOGS_DIR/searxng.log" 2>&1
    # Wait for ready
    for i in $(seq 1 15); do
      curl -sf http://127.0.0.1:8888/healthz >/dev/null 2>&1 && break
      sleep 1
    done
    echo "SearXNG started"
    ;;

  comfyui)
    if [ "$ACTION" = "restart" ]; then
      pkill -f "ComfyUI-src/main.py" 2>/dev/null || true
      sleep 2
    fi
    if pgrep -f "ComfyUI-src/main.py" >/dev/null 2>&1; then
      echo "ComfyUI already running"
      exit 0
    fi
    /Users/lytic/software/ai/ComfyUI/.venv/bin/python \
      /Users/lytic/software/ai/ComfyUI-src/main.py \
      --base-directory /Users/lytic/software/ai/ComfyUI \
      --listen 127.0.0.1 --port 8000 --dont-print-server \
      >> "$LOGS_DIR/comfyui.log" 2>&1 &
    echo "ComfyUI started (pid $!)"
    ;;

  ollamadiffuser)
    if [ "$ACTION" = "restart" ]; then
      pkill -f "ollamadiffuser" 2>/dev/null || true
      sleep 2
    fi
    if pgrep -f "ollamadiffuser" >/dev/null 2>&1; then
      echo "OllamaDiffuser already running"
      exit 0
    fi
    /Users/lytic/venvs/nanoclaw/bin/ollamadiffuser \
      --mode api --host 127.0.0.1 --port 8001 \
      >> "$LOGS_DIR/ollamadiffuser.log" 2>&1 &
    echo "OllamaDiffuser started (pid $!)"
    ;;

  ollama)
    if [ "$ACTION" = "restart" ]; then
      pkill -f "ollama serve" 2>/dev/null || true
      sleep 2
    fi
    if curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo "Ollama already running"
      exit 0
    fi
    open -a Ollama 2>/dev/null || ollama serve >> "$LOGS_DIR/ollama.log" 2>&1 &
    echo "Ollama starting"
    ;;

  *)
    echo "Unknown service: $SERVICE"
    echo "Valid services: searxng, comfyui, ollamadiffuser, ollama"
    exit 1
    ;;
esac
