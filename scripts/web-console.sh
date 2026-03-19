#!/bin/bash
# Launch Claude Code in a tmux session and serve it via a mobile-friendly web terminal.
# Usage: ./scripts/web-console.sh [port]
#
# Access from any device on the network: http://<mac-ip>:<port>
# Default port: 7681

set -e
PORT="${1:-7681}"
TTYD_PORT=$((PORT + 1))
SESSION="claude"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")

eval "$(/opt/homebrew/bin/brew shellenv)"

# tmux session
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Attaching to existing tmux session '$SESSION'"
else
  echo "Creating new tmux session '$SESSION' with Claude Code..."
  tmux new-session -d -s "$SESSION" -c "/Users/lytic/software/ai/nanoclaw" "claude"
fi

tmux set-option -t "$SESSION" escape-time 50 2>/dev/null || true

# Clean up prior instances
pkill -f "ttyd.*tmux attach" 2>/dev/null || true
sleep 1

echo ""
echo "  Web Console: http://${LOCAL_IP}:${PORT}"
echo ""

# Build the wrapper page with the actual ttyd port baked in
SERVE_DIR=$(mktemp -d /tmp/web-console-XXXXX)
sed "s|TTYD_PORT|${TTYD_PORT}|g" "$SCRIPT_DIR/web-console.html" > "$SERVE_DIR/index.html"

cleanup() {
  kill $TTYD_PID 2>/dev/null || true
  kill $HTTP_PID 2>/dev/null || true
  rm -rf "$SERVE_DIR"
}
trap cleanup EXIT INT TERM

# Start ttyd (internal, not user-facing)
ttyd -W -p "$TTYD_PORT" \
  -P 1 \
  tmux attach -t "$SESSION" &
TTYD_PID=$!

# Serve the mobile-friendly wrapper on the main port
python3 -c "
import http.server, socketserver, os
os.chdir('$SERVE_DIR')
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('0.0.0.0', $PORT), http.server.SimpleHTTPRequestHandler) as s:
    s.serve_forever()
" &
HTTP_PID=$!

wait $TTYD_PID
