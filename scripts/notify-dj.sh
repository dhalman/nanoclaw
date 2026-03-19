#!/bin/bash
# Send a Telegram message to DJ from Claude Code via Andy's bot.
# Usage: ./scripts/notify-dj.sh "message text"
#
# Uses Andy's main bot (not Jarvis) so DJ sees it in his Andy DM.
# Keeps Jarvis clean as a product interface.
# Supports Telegram Markdown: *bold*, _italic_, `code`, ```pre```

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Use Andy's bot token (first pool bot)
TELEGRAM_BOT_POOL=$(grep '^TELEGRAM_BOT_POOL=' "$PROJECT_ROOT/.env" | cut -d= -f2)
ANDY_BOT_TOKEN=$(echo "$TELEGRAM_BOT_POOL" | cut -d, -f1)
DJ_CHAT_ID="365278370"

MESSAGE="$1"
if [ -z "$MESSAGE" ]; then
  echo "Usage: $0 \"message text\""
  exit 1
fi

curl -sf "https://api.telegram.org/bot${ANDY_BOT_TOKEN}/sendMessage" \
  -d chat_id="$DJ_CHAT_ID" \
  -d parse_mode="Markdown" \
  --data-urlencode text="$MESSAGE" \
  > /dev/null

echo "Sent to DJ via Andy's bot."
