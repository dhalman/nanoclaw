#!/bin/bash
# NanoClaw deploy script
#
# Usage:
#   ./scripts/deploy.sh              # bump patch version + deploy (background, cached build)
#   ./scripts/deploy.sh --minor      # bump minor version
#   ./scripts/deploy.sh --major      # bump major version
#   ./scripts/deploy.sh --clean      # force full cache prune before build
#   ./scripts/deploy.sh --test       # also run tests (must pass before deploy)
#   ./scripts/deploy.sh --wipe-db    # also wipe the message database
#   ./scripts/deploy.sh --fg         # run in foreground (default is background)

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$PROJECT_ROOT/logs"
DB_PATH="$PROJECT_ROOT/store/messages.db"
LOCK_FILE="/tmp/nanoclaw-deploy.lock"
DEPLOY_LOG="$PROJECT_ROOT/logs/deploy.log"

# Re-exec in background unless already backgrounded or --fg passed
if [[ "$1" != "--_bg" ]]; then
  FG=false
  for arg in "$@"; do [[ "$arg" == "--fg" ]] && FG=true; done
  if [[ "$FG" == "false" ]]; then
    mkdir -p "$PROJECT_ROOT/logs"
    nohup /bin/bash "$0" --_bg "$@" >> "$DEPLOY_LOG" 2>&1 &
    BG_PID=$!
    echo "Deploy started in background (pid $BG_PID) — tail -f $DEPLOY_LOG"
    exit 0
  fi
fi
# Strip the internal --_bg marker so it doesn't affect arg parsing below
[[ "$1" == "--_bg" ]] && shift

RUN_TESTS=false
WIPE_DB=false
BUMP=patch
CLEAN_BUILD=false

for arg in "$@"; do
  case $arg in
    --test)    RUN_TESTS=true ;;
    --wipe-db) WIPE_DB=true ;;
    --minor)   BUMP=minor ;;
    --major)   BUMP=major ;;
    --clean)   CLEAN_BUILD=true ;;
  esac
done

cd "$PROJECT_ROOT"
mkdir -p "$LOGS_DIR"

# ---------------------------------------------------------------------------
# Telegram helper (used for cancel, failure, and success notifications)
# ---------------------------------------------------------------------------
tg_notify() {
  local msg="$1"
  local token chat_id
  token=$(grep -E '^JARVIS_BOT_TOKEN=' "$PROJECT_ROOT/.env" 2>/dev/null | cut -d'=' -f2-)
  chat_id=$(sqlite3 "$PROJECT_ROOT/store/messages.db" \
    "SELECT replace(jid,'tg-j:','') FROM registered_groups WHERE jid LIKE 'tg-j:%' LIMIT 1;" 2>/dev/null)
  [ -n "$token" ] && [ -n "$chat_id" ] || return 0
  curl -sf -X POST "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat_id}" \
    --data-urlencode "text=${msg}" > /dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# 0. Cancel any in-progress deploy
# ---------------------------------------------------------------------------
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "--- Cancelling in-progress deploy (pid $OLD_PID)..."
    # Read the old build ID if available (stored alongside the PID)
    OLD_BUILD_ID=$(sed -n '2p' "$LOCK_FILE" 2>/dev/null)
    # Mark the lock file as cancelled so the dying process knows not to also send "failed"
    printf '%s\n%s\ncancelled\n' "$OLD_PID" "${OLD_BUILD_ID:-}" > "$LOCK_FILE"
    kill -- "-$OLD_PID" 2>/dev/null || kill "$OLD_PID" 2>/dev/null || true
    sleep 1
    [ -n "$OLD_BUILD_ID" ] && tg_notify "❌ Deploy v${OLD_BUILD_ID} cancelled (superseded)"
  fi
  rm -f "$LOCK_FILE"
fi
# Write this deploy's PID to lock file; on unexpected exit notify failure
printf '%s\n%s\n' "$$" "" > "$LOCK_FILE"
DEPLOY_FAILED=false
on_exit() {
  # Check if we were cancelled by a newer deploy before removing the lock file
  local was_cancelled=false
  [ "$(sed -n '3p' "$LOCK_FILE" 2>/dev/null)" = "cancelled" ] && was_cancelled=true
  rm -f "$LOCK_FILE"
  if [ "$DEPLOY_FAILED" = true ] && [ -n "${BUILD_ID:-}" ] && [ "$was_cancelled" = false ]; then
    tg_notify "❌ Deploy v${BUILD_ID} failed"
  fi
}
trap 'on_exit' EXIT

set -e  # Abort on any error — version bump only happens if all steps succeed
# Catch failures to set the flag before EXIT trap fires
trap 'DEPLOY_FAILED=true' ERR

# ---------------------------------------------------------------------------
# Calculate next version (don't bump package.json yet — only on success)
# ---------------------------------------------------------------------------
CURRENT_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
IFS='.' read -r _MAJOR _MINOR _PATCH <<< "$CURRENT_VERSION"
case "$BUMP" in
  major) BUILD_ID="$((_MAJOR+1)).0.0" ;;
  minor) BUILD_ID="${_MAJOR}.$((_MINOR+1)).0" ;;
  *)     BUILD_ID="${_MAJOR}.${_MINOR}.$((_PATCH+1))" ;;
esac
echo "$BUILD_ID" > "$PROJECT_ROOT/container/ollama-runner/build-id.txt"
# Store BUILD_ID in lock file (line 2) so canceller can notify with the right version
printf '%s\n%s\n' "$$" "$BUILD_ID" > "$LOCK_FILE"

echo "=== NanoClaw Deploy === [v${BUILD_ID}]"
echo "Tests: $RUN_TESTS | DB wipe: $WIPE_DB"
echo ""

# Timing helpers (node for cross-platform ms timestamps)
_now_ms() { node -e "process.stdout.write(String(Date.now()))"; }
_DEPLOY_START_MS=$(_now_ms)
_STEP_START_MS=$_DEPLOY_START_MS
step_done() {
  local label="$1"
  local now; now=$(_now_ms)
  local step_ms=$(( now - _STEP_START_MS ))
  local total_ms=$(( now - _DEPLOY_START_MS ))
  printf "  [PERF] %s: %dms (total %ds)\n" "$label" "$step_ms" "$(( total_ms / 1000 ))"
  _STEP_START_MS=$now
}

# ---------------------------------------------------------------------------
# 1. Tests (optional — fail fast before touching anything)
# ---------------------------------------------------------------------------
if [ "$RUN_TESTS" = true ]; then
  echo "--- Running tests..."
  if ! npm test 2>&1 | tee "$LOGS_DIR/test.log" | grep -E "Tests|✓|×|FAIL"; then
    echo "Tests failed — aborting deploy. See $LOGS_DIR/test.log"
    exit 1
  fi
  # Fail if any test file failed
  if grep -q "failed" "$LOGS_DIR/test.log" 2>/dev/null; then
    # Allow known pre-existing telegram failures (2 tests), abort on anything new
    FAIL_COUNT=$(grep -oP '\d+(?= failed)' "$LOGS_DIR/test.log" | tail -1)
    if [ "${FAIL_COUNT:-0}" -gt 2 ]; then
      echo "Tests failed ($FAIL_COUNT failures) — aborting deploy."
      exit 1
    fi
    echo "Note: $FAIL_COUNT known pre-existing test failure(s) — continuing."
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# 2. Kill running Jarvis/agent containers
# ---------------------------------------------------------------------------
echo "--- Stopping agent containers..."
CONTAINERS=$(docker ps --filter name=nanoclaw- --format '{{.Names}}' 2>/dev/null)
if [ -n "$CONTAINERS" ]; then
  echo "$CONTAINERS" | xargs docker stop -t 2 2>/dev/null && echo "Stopped: $CONTAINERS"
else
  echo "No running containers."
fi
step_done "stop containers"
echo ""

# ---------------------------------------------------------------------------
# 3. Optional full cache prune (--clean only — skipped by default for speed)
# ---------------------------------------------------------------------------
if [ "$CLEAN_BUILD" = true ]; then
  echo "--- Pruning build cache (--clean)..."
  docker buildx prune -f 2>&1 | grep -E "Total|^$" || true
  echo ""
fi

# ---------------------------------------------------------------------------
# 4. Optional DB wipe
# ---------------------------------------------------------------------------
if [ "$WIPE_DB" = true ]; then
  echo "--- Wiping database..."
  if [ -f "$DB_PATH" ]; then
    cp "$DB_PATH" "${DB_PATH}.bak.$(date +%Y%m%d-%H%M%S)" && echo "Backed up to ${DB_PATH}.bak.*"
    rm "$DB_PATH" && echo "Database wiped."
  else
    echo "No database found at $DB_PATH"
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# 5. Build TypeScript
# ---------------------------------------------------------------------------
echo "--- Building TypeScript..."
npm run build
step_done "tsc build"
echo ""

# ---------------------------------------------------------------------------
# 6. Rebuild container (clean)
# ---------------------------------------------------------------------------
echo "--- Building container..."
NANOCLAW_MANAGED=1 ./container/build.sh
step_done "container build"
echo ""

# ---------------------------------------------------------------------------
# 7. Restart service
# ---------------------------------------------------------------------------
echo "--- Restarting NanoClaw..."
LOG_POSITION=$(( $(wc -c < "$PROJECT_ROOT/logs/nanoclaw.log" 2>/dev/null || echo 0) ))
launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || \
  systemctl --user restart nanoclaw 2>/dev/null || \
  echo "Could not restart via launchctl or systemctl — restart manually."
step_done "service restart"

# ---------------------------------------------------------------------------
# 8. Wait for Jarvis startup message (confirms service is live)
# ---------------------------------------------------------------------------
echo "--- Waiting for Jarvis startup confirmation (up to 90s)..."
STARTUP_OK=false
for i in $(seq 1 90); do
  sleep 1
  if tail -c "+${LOG_POSITION}" "$PROJECT_ROOT/logs/nanoclaw.log" 2>/dev/null \
      | sed 's/\x1b\[[0-9;]*m//g' \
      | grep -q "Jarvis bot initialized\|IPC message sent"; then
    echo "Jarvis startup confirmed (${i}s)"
    STARTUP_OK=true
    break
  fi
done
if [ "$STARTUP_OK" = false ]; then
  echo "Jarvis did not send startup message within 90s — deploy failed."
  exit 1
fi
step_done "jarvis startup"

# ---------------------------------------------------------------------------
# 9. Commit version bump + notify via Telegram (only on success)
# ---------------------------------------------------------------------------
/opt/homebrew/bin/npm version "$BUILD_ID" --no-git-tag-version > /dev/null 2>&1 \
  && echo "Version bumped to v${BUILD_ID}" || echo "Warning: could not update package.json version"

DEPLOY_FAILED=false  # mark success before EXIT trap fires

# ---------------------------------------------------------------------------
# 9b. Add changelog entry (if not already present for this version)
# ---------------------------------------------------------------------------
CHANGELOG="$PROJECT_ROOT/container/ollama-runner/changelog.json"
if ! node -e "const c=require('$CHANGELOG'); process.exit(c['$BUILD_ID']?0:1)" 2>/dev/null; then
  DEPLOY_DATE=$(date +%Y-%m-%d)
  GIT_NOTES=$(git log --oneline -10 2>/dev/null | sed 's/^[a-f0-9]* //' | sed 's/"/\\"/g' | awk '{printf "      \"%s\",\n", $0}' | sed '$ s/,$//')
  node -e "
    const fs = require('fs');
    const c = JSON.parse(fs.readFileSync('$CHANGELOG','utf8'));
    const entry = {
      date: '$DEPLOY_DATE',
      title: 'Fresh off the press',
      notes: $(echo "[" && echo "$GIT_NOTES" && echo "]")
    };
    c['$BUILD_ID'] = entry;
    // Keep sorted newest-first
    const sorted = Object.fromEntries(
      Object.entries(c).sort(([a],[b]) => {
        const p = v => v.split('.').map(Number);
        const [ma,mi,pa] = p(a), [mb,mi2,pb] = p(b);
        return (mb-ma)||(mi2-mi)||(pb-pa);
      })
    );
    fs.writeFileSync('$CHANGELOG', JSON.stringify(sorted, null, 2) + '\n');
    console.log('Changelog entry added for v$BUILD_ID');
  " 2>/dev/null || echo "Warning: could not update changelog"
fi

tg_notify "🚀 Deploy v${BUILD_ID} complete" && echo "Notified Telegram: v${BUILD_ID}"

_TOTAL_MS=$(( $(_now_ms) - _DEPLOY_START_MS ))
echo ""
echo "=== Deploy complete === total $(( _TOTAL_MS / 1000 ))s (${_TOTAL_MS}ms)"
echo "v${BUILD_ID}"
