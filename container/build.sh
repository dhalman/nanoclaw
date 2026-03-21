#!/bin/bash
# Build the NanoClaw agent container image
#
# Pipeline: compile to staging → test → version bump → promote → build image → verify → commit → deploy
#
# Ollama-runner code is compiled to builds/staging/ first, tested there, then
# promoted to builds/<version>/ with a builds/live symlink swap. Containers
# mount pre-compiled JS from builds/live/ — no runtime TSC, no stale code.
#
# Usage:
#   ./container/build.sh            # full build: compile → test → promote → docker → deploy
#   ./container/build.sh --staging   # staging only: compile → test → restart Jarvis DM (live untouched)
#   ./container/build.sh --minor    # bump minor version
#   ./container/build.sh --major    # bump major version
#   ./container/build.sh --skip-tests  # skip test gate (emergency hotfix only)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="latest"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
BUMP=patch
SKIP_TESTS=false
STAGING_ONLY=false

for arg in "$@"; do
  case $arg in
    --minor) BUMP=minor ;;
    --major) BUMP=major ;;
    --skip-tests) SKIP_TESTS=true ;;
    --staging) STAGING_ONLY=true ;;
  esac
done

BUILDS_DIR="$PROJECT_ROOT/builds"
STAGING_DIR="$BUILDS_DIR/staging"

# ---------------------------------------------------------------------------
# 1. Compile host TypeScript (Jarvis still running)
# ---------------------------------------------------------------------------
echo "Compiling host TypeScript..."
cd "$PROJECT_ROOT"
/opt/homebrew/bin/npm run build
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# 2. Compile ollama-runner to staging sandbox
# ---------------------------------------------------------------------------
echo "Compiling ollama-runner to staging..."
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# Compile TS to staging directory
cd "$PROJECT_ROOT/container/ollama-runner"
/opt/homebrew/bin/npx tsc --outDir "$STAGING_DIR/dist"

# Copy non-TS assets needed at runtime
cp build-id.txt "$STAGING_DIR/" 2>/dev/null || true
cp changelog.json "$STAGING_DIR/" 2>/dev/null || true

cd "$SCRIPT_DIR"
echo "Staging build ready: $STAGING_DIR"

# ---------------------------------------------------------------------------
# 3. Test gate (runs against staged code — Jarvis still running)
# ---------------------------------------------------------------------------
if [ "$SKIP_TESTS" = "true" ]; then
  echo "⚠️  Tests skipped (--skip-tests)"
else
  echo "Running test suite..."
  cd "$PROJECT_ROOT"
  # Run container tests (no native module dependency)
  CONTAINER_OUTPUT=$(cd container/ollama-runner && /opt/homebrew/bin/npx vitest run 2>&1)
  CONTAINER_CLEAN=$(echo "$CONTAINER_OUTPUT" | sed 's/\x1B\[[0-9;]*m//g')
  CONTAINER_SUMMARY=$(echo "$CONTAINER_CLEAN" | grep -E "^\s*(Test Files|Tests)\s" || true)
  if echo "$CONTAINER_SUMMARY" | grep -q "failed"; then
    echo "$CONTAINER_OUTPUT"
    echo ""
    echo "❌ CONTAINER TESTS FAILED — deploy aborted. Staged build NOT promoted."
    exit 1
  fi
  CONTAINER_PASS=$(echo "$CONTAINER_SUMMARY" | grep "Tests" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")

  # Run host tests that don't depend on better-sqlite3 native module
  HOST_OUTPUT=$(/opt/homebrew/bin/npx vitest run \
    src/channels/telegram.test.ts \
    src/engagement.test.ts src/translation.test.ts src/formatting.test.ts \
    src/config.test.ts src/group-folder.test.ts \
    src/container-runner.test.ts src/container-runtime.test.ts \
    src/credential-proxy.test.ts src/env.test.ts src/group-queue.test.ts \
    src/mount-security.test.ts src/sender-allowlist.test.ts \
    src/snapshots.test.ts src/timezone.test.ts \
    src/transcription.test.ts src/video-cancel.test.ts 2>&1)
  HOST_CLEAN=$(echo "$HOST_OUTPUT" | sed 's/\x1B\[[0-9;]*m//g')
  HOST_SUMMARY=$(echo "$HOST_CLEAN" | grep -E "^\s*(Test Files|Tests)\s" || true)
  if echo "$HOST_SUMMARY" | grep -q "failed"; then
    echo "$HOST_OUTPUT"
    echo ""
    echo "❌ HOST TESTS FAILED — deploy aborted. Staged build NOT promoted."
    exit 1
  fi
  HOST_PASS=$(echo "$HOST_SUMMARY" | grep "Tests" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo "0")

  echo "✅ Tests passed (${CONTAINER_PASS} container + ${HOST_PASS} host)"
  cd "$SCRIPT_DIR"
fi

# ---------------------------------------------------------------------------
# Staging-only: stop here, just restart the staging container
# ---------------------------------------------------------------------------
if [ "$STAGING_ONLY" = "true" ]; then
  echo "Staging build ready. Skipping promotion, docker build, and commit."
  if [ "${NANOCLAW_MANAGED}" != "1" ]; then
    # Only kill the staging container — the host's prespawn loop auto-restarts it
    # with the new code from builds/staging/. Live containers are untouched.
    STAGING_CONTAINERS=$(docker ps -q --filter 'name=nanoclaw-telegram-ollama' 2>/dev/null)
    if [ -n "$STAGING_CONTAINERS" ]; then
      echo "Stopping staging container: $(docker ps --filter 'name=nanoclaw-telegram-ollama' --format '{{.Names}}')"
      echo "$STAGING_CONTAINERS" | xargs docker stop -t 2 2>/dev/null || true
      docker wait $STAGING_CONTAINERS 2>/dev/null || true
      echo "Host will auto-respawn with new staging code."
    else
      echo "No staging container running. Changes will take effect on next start."
    fi
  fi
  echo "Staging deploy complete."
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Version bump
# ---------------------------------------------------------------------------
CURRENT_VERSION=$(/opt/homebrew/bin/node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || echo "0.0.0")
IFS='.' read -r _MAJOR _MINOR _PATCH <<< "$CURRENT_VERSION"
case "$BUMP" in
  major) BUILD_ID="$((_MAJOR+1)).0.0" ;;
  minor) BUILD_ID="${_MAJOR}.$((_MINOR+1)).0" ;;
  *)     BUILD_ID="${_MAJOR}.${_MINOR}.$((_PATCH+1))" ;;
esac
echo "$BUILD_ID" > "$PROJECT_ROOT/container/ollama-runner/build-id.txt"
/opt/homebrew/bin/npm version "$BUILD_ID" --no-git-tag-version --prefix "$PROJECT_ROOT" > /dev/null 2>&1 \
  && echo "Version bumped to v${BUILD_ID}" || echo "Warning: could not update package.json version"

# ---------------------------------------------------------------------------
# 5. Promote staging → versioned build + update live symlink
# ---------------------------------------------------------------------------
VERSION_DIR="$BUILDS_DIR/$BUILD_ID"
rm -rf "$VERSION_DIR"
cp -R "$STAGING_DIR" "$VERSION_DIR"
# Stamp the promoted build with the version
echo "$BUILD_ID" > "$VERSION_DIR/build-id.txt"

# Atomic symlink swap: remove old, create new (ln -sfn is atomic on same filesystem)
rm -f "$BUILDS_DIR/live"
ln -sfn "$VERSION_DIR" "$BUILDS_DIR/live"
echo "Promoted build: $VERSION_DIR"
echo "Live symlink: $(readlink "$BUILDS_DIR/live")"

# Clean up old builds (keep last 5)
cd "$BUILDS_DIR"
ls -dt [0-9]*.* 2>/dev/null | tail -n +6 | xargs rm -rf 2>/dev/null || true
cd "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# 6. Changelog
# ---------------------------------------------------------------------------
PREV_TAG="v${CURRENT_VERSION}"
if git -C "$PROJECT_ROOT" rev-parse "$PREV_TAG" >/dev/null 2>&1; then
  COMMIT_RANGE="${PREV_TAG}..HEAD"
else
  COMMIT_RANGE="HEAD~5..HEAD"
fi
CHANGELOG_FILE="$PROJECT_ROOT/container/ollama-runner/changelog.json"
python3 - "$CHANGELOG_FILE" "$BUILD_ID" "$CURRENT_VERSION" "$COMMIT_RANGE" "$PROJECT_ROOT" <<'PYEOF'
import json, sys, datetime, subprocess

changelog_path, new_ver, prev_ver, commit_range, project_root = sys.argv[1:]

result = subprocess.run(
    ['git', '-C', project_root, 'log', '--oneline', '--no-merges', commit_range],
    capture_output=True, text=True
)
commits = [line.split(' ', 1)[1] for line in result.stdout.strip().splitlines() if ' ' in line]
commits = [c for c in commits if not c.startswith('build: v')]
title = commits[0] if commits else f'Build {new_ver}'

with open(changelog_path) as f:
    data = json.load(f)

entry = {'date': datetime.date.today().isoformat(), 'title': title, 'notes': commits}
new_data = {new_ver: entry}
new_data.update(data)

with open(changelog_path, 'w') as f:
    json.dump(new_data, f, indent=2)
print(f'Changelog updated: v{new_ver}')
PYEOF

# Also copy changelog to promoted build
cp "$CHANGELOG_FILE" "$VERSION_DIR/changelog.json"

# ---------------------------------------------------------------------------
# 7. Docker build (Jarvis still running — containers coexist)
# ---------------------------------------------------------------------------
echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .

# ---------------------------------------------------------------------------
# 8. Image verification
# ---------------------------------------------------------------------------
BAKED_ID=$(${CONTAINER_RUNTIME} run --rm --entrypoint cat "${IMAGE_NAME}:${TAG}" /app/ollama-runner/build-id.txt 2>/dev/null || echo "unknown")
if [ "$BAKED_ID" != "$BUILD_ID" ]; then
  echo "⚠️  Image verification failed — baked ID is ${BAKED_ID}, expected ${BUILD_ID}"
  echo "Pruning buildkit cache and rebuilding from scratch..."
  ${CONTAINER_RUNTIME} builder prune -af 2>/dev/null || true
  ${CONTAINER_RUNTIME} build --no-cache --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .
  BAKED_ID=$(${CONTAINER_RUNTIME} run --rm --entrypoint cat "${IMAGE_NAME}:${TAG}" /app/ollama-runner/build-id.txt 2>/dev/null || echo "unknown")
  if [ "$BAKED_ID" != "$BUILD_ID" ]; then
    echo "ERROR: Build verification failed even after clean rebuild. Expected ${BUILD_ID}, got ${BAKED_ID}. Aborting."
    exit 1
  fi
fi
echo "✅ Image verified: build ID ${BAKED_ID}"

# Clear build-status so containers don't warn about stale images
echo "{\"status\":\"ok\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"version\":\"${BUILD_ID}\"}" > "$PROJECT_ROOT/.build-status.json"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# ---------------------------------------------------------------------------
# 9. Git commit + tag
# ---------------------------------------------------------------------------
git -C "$PROJECT_ROOT" add \
  container/ollama-runner/build-id.txt \
  package.json \
  package-lock.json \
  container/ollama-runner/changelog.json \
  2>/dev/null || true
if git -C "$PROJECT_ROOT" diff --cached --quiet; then
  echo "Nothing to commit for v${BUILD_ID}"
else
  git -C "$PROJECT_ROOT" commit -m "build: v${BUILD_ID}" \
    2>/dev/null && echo "Committed v${BUILD_ID}" \
    || echo "Warning: git commit failed"
fi
git -C "$PROJECT_ROOT" tag -f "v${BUILD_ID}" \
  2>/dev/null && echo "Tagged v${BUILD_ID}" \
  || echo "Warning: git tag failed"

# ---------------------------------------------------------------------------
# 10. Deploy — only stop ollama-runner containers, leave Claude containers alone
# ---------------------------------------------------------------------------
if [ "${NANOCLAW_MANAGED}" != "1" ]; then
  echo "Deploying v${BUILD_ID}..."

  # Only kill ollama-runner containers (they mount the build).
  # Claude containers (Andy etc.) are unaffected — no stale code risk.
  OLLAMA_CONTAINERS=$(docker ps -q --filter 'name=nanoclaw-telegram-ollama' --filter 'name=nanoclaw-telegram-group' 2>/dev/null)
  if [ -n "$OLLAMA_CONTAINERS" ]; then
    echo "Stopping ollama containers: $(docker ps --filter 'name=nanoclaw-telegram-ollama' --filter 'name=nanoclaw-telegram-group' --format '{{.Names}}' | tr '\n' ' ')"
    echo "$OLLAMA_CONTAINERS" | xargs docker stop -t 2 2>/dev/null || true
    docker wait $OLLAMA_CONTAINERS 2>/dev/null || true
  fi

  # Restart host process — picks up new host code + spawns new ollama containers from builds/live
  echo "Starting nanoclaw v${BUILD_ID}..."
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || true
fi
echo "Done."
