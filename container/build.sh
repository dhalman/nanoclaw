#!/bin/bash
# Build the NanoClaw agent container image
# Always: stops nanoclaw, purges builder cache, does a clean build, then restarts.
#
# Usage:
#   ./container/build.sh          # bump patch version + build
#   ./container/build.sh --minor  # bump minor version
#   ./container/build.sh --major  # bump major version

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="latest"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"
BUMP=patch

for arg in "$@"; do
  case $arg in
    --minor) BUMP=minor ;;
    --major) BUMP=major ;;
  esac
done

# Stop nanoclaw service (standalone builds only — managed builds are already inside the service)
if [ "${NANOCLAW_MANAGED}" != "1" ]; then
  echo "Stopping nanoclaw..."
  launchctl stop gui/$(id -u)/com.nanoclaw 2>/dev/null || true
fi

# Always bump version — every build, deploy, and code change gets a new version.
# Restarts (launchctl kickstart without build.sh) do NOT bump.
CURRENT_VERSION=$(node -p "require('$PROJECT_ROOT/package.json').version" 2>/dev/null || echo "0.0.0")
IFS='.' read -r _MAJOR _MINOR _PATCH <<< "$CURRENT_VERSION"
case "$BUMP" in
  major) BUILD_ID="$((_MAJOR+1)).0.0" ;;
  minor) BUILD_ID="${_MAJOR}.$((_MINOR+1)).0" ;;
  *)     BUILD_ID="${_MAJOR}.${_MINOR}.$((_PATCH+1))" ;;
esac
echo "$BUILD_ID" > "$PROJECT_ROOT/container/ollama-runner/build-id.txt"
/opt/homebrew/bin/npm version "$BUILD_ID" --no-git-tag-version --prefix "$PROJECT_ROOT" > /dev/null 2>&1 \
  && echo "Version bumped to v${BUILD_ID}" || echo "Warning: could not update package.json version"

# Generate changelog entry from commits since last tag
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
# Filter out version bump commits
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

# Kill all running agent containers so the new image is picked up immediately
echo "Killing running agent containers..."
docker kill $(docker ps -q) 2>/dev/null || true
docker rm $(docker ps -aq) 2>/dev/null || true

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Stable layers (apt-get, npm globals, npm install) are reused from cache.
# Source layers (COPY agent-runner/, COPY ollama-runner/) are invalidated
# automatically by Docker's content-hash detection when files change.
# build-id.txt is always written fresh before this runs, guaranteeing
# the ollama-runner COPY is always invalidated.
${CONTAINER_RUNTIME} build --build-arg CACHEBUST="$(date +%s)" -t "${IMAGE_NAME}:${TAG}" .

# Verify the baked-in build ID matches what we wrote to build-id.txt.
# Buildkit's content cache can silently serve stale file bytes even with CACHEBUST,
# producing a "successful" build with old source. This catches it immediately.
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

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

# Ollama-runner source is bind-mounted from the host at runtime, so no
# post-build sync is needed — containers always compile from the latest source.

# Commit and tag the new version
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

# Restart nanoclaw with the new image (skip when called from within the service)
if [ "${NANOCLAW_MANAGED}" != "1" ]; then
  echo "Restarting nanoclaw..."
  launchctl kickstart -k gui/$(id -u)/com.nanoclaw 2>/dev/null || true
fi
echo "Done."
