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

# Enable parallel requests (2 concurrent inferences on same model)
launchctl setenv OLLAMA_NUM_PARALLEL 2 2>/dev/null || export OLLAMA_NUM_PARALLEL=2

# Restart Ollama to clear any hung state and pick up env vars
echo "Restarting Ollama..."
pkill -f 'ollama' 2>/dev/null || true
sleep 2
open -a Ollama 2>/dev/null || (OLLAMA_NUM_PARALLEL=2 nohup ollama serve > /dev/null 2>&1 &)

for i in $(seq 1 30); do
  curl -sf "$OLLAMA_HOST/api/tags" > /dev/null 2>&1 && break
  sleep 1
done
echo "Ollama ready."

warm() {
  local MODEL="$1"
  local KEEP_ALIVE="$2"
  curl -s --max-time 120 -X POST "$OLLAMA_HOST/api/chat" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"keep_alive\":\"$KEEP_ALIVE\",\"options\":{\"num_predict\":1},\"stream\":false}" \
    > /dev/null 2>&1 && echo "$MODEL loaded (keep_alive=$KEEP_ALIVE)" || echo "$MODEL failed"
}

# Secretary (gemma3:4b for classification) + translator (qwen2.5:3b for translations)
warm "gemma3:4b" "-1"
warm "qwen2.5:3b" "-1"

# Coordinator second (large) — staggered so secretary is ready first
warm "qwen3.5:35b" "-1"

echo "All models warm."
