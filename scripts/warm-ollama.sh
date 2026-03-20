#!/bin/bash
# Warms up Ollama models on startup so first Jarvis response is fast.
# Secretary (qwen2.5:3b) loads first — needed for classify + translations.
# Coordinator (qwen3.5:35b) loads second — handles all inference.
# Both pinned with keep_alive=-1 (never evict).

# Use OLLAMA_HOST only if it's a full URL; 0.0.0.0 is a bind address, not a client URL
_raw="${OLLAMA_HOST:-}"
if [[ "$_raw" == http* ]]; then
  OLLAMA_HOST="$_raw"
else
  OLLAMA_HOST="http://localhost:11434"
fi

# Wait for Ollama to be ready
for i in $(seq 1 30); do
  curl -sf "$OLLAMA_HOST/api/tags" > /dev/null 2>&1 && break
  sleep 1
done

warm() {
  local MODEL="$1"
  local KEEP_ALIVE="$2"
  curl -s --max-time 120 -X POST "$OLLAMA_HOST/api/chat" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"keep_alive\":\"$KEEP_ALIVE\",\"options\":{\"num_predict\":1},\"stream\":false}" \
    > /dev/null 2>&1 && echo "$MODEL loaded (keep_alive=$KEEP_ALIVE)" || echo "$MODEL failed"
}

# Secretary first (small, fast) — needed for classify + translations
warm "qwen2.5:3b" "-1"

# Coordinator second (large) — staggered so secretary is ready first
warm "qwen3.5:35b" "-1"

echo "All models warm."
