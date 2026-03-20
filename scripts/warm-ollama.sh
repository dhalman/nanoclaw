#!/bin/bash
# Warms up Ollama models on startup so first Jarvis response is fast.
# All models evict after 2 minutes of idle (matches OLLAMA_KEEP_ALIVE=2m server default).

# Use OLLAMA_HOST only if it's a full URL; 0.0.0.0 is a bind address, not a client URL
_raw="${OLLAMA_HOST:-}"
if [[ "$_raw" == http* ]]; then
  OLLAMA_HOST="$_raw"
else
  OLLAMA_HOST="http://localhost:11434"
fi

# Set server-level default eviction (takes effect on next Ollama restart)
launchctl setenv OLLAMA_KEEP_ALIVE 2m 2>/dev/null || true

keep_warm(KEEP_ALIVE) {
  local MODEL="$1"
  curl -sf -X POST "$OLLAMA_HOST/api/chat" \
   -H 'Content-Type: application/json' \
   -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"keep_alive\":\"$KEEP_ALIVE\",\"stream\":false}" \
   > /dev/null && echo "$MODEL loaded" || echo "$MODEL failed (may not be installed)"
}

keep_warm(-1) "qwen3:4b" &         # first responder, efficiency model — always warm (this one needs to load before chat is active)
keep_warm(-1) "qwen3.5:35b" &      # default model, coordinator — always warm, but don't block startup

echo "Ready to chat!"

