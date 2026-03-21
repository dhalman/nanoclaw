# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# CACHEBUST invalidates everything below this line on every deploy,
# ensuring source code is always fresh while apt/npm layers above are reused.
ARG CACHEBUST=1

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Ollama runner: pre-compiled JS is bind-mounted from builds/live/ at runtime.
# No runtime TSC — the build script compiles, tests, and promotes before deploy.
# COPY is kept as a fallback — if nothing is mounted, the baked-in build is used.
COPY ollama-runner/ /app/ollama-runner/
RUN cd /app/ollama-runner && /app/node_modules/.bin/tsc
RUN printf '#!/bin/bash\nset -e\n# Use pre-compiled build from host mount (preferred) or baked-in fallback\nif [ -d /app/ollama-build/dist ]; then\n  DIST_DIR=/app/ollama-build/dist\n  BUILD_ID_FILE=/app/ollama-build/build-id.txt\nelse\n  DIST_DIR=/app/ollama-runner/dist\n  BUILD_ID_FILE=/app/ollama-runner/build-id.txt\nfi\n# Version gate: verify build matches expected version\nif [ -n "$EXPECTED_BUILD_ID" ] && [ -f "$BUILD_ID_FILE" ]; then\n  COMPILED_ID=$(cat "$BUILD_ID_FILE" 2>/dev/null || echo "unknown")\n  if [ "$COMPILED_ID" != "$EXPECTED_BUILD_ID" ]; then\n    echo "[nanoclaw] FATAL: Build version mismatch — found $COMPILED_ID but expected $EXPECTED_BUILD_ID" >&2\n    exit 1\n  fi\nfi\ncat > /tmp/ollama-input.json\nNODE_PATH=/app/node_modules node "$DIST_DIR/index.js" < /tmp/ollama-input.json\n' > /app/ollama-entrypoint.sh && chmod +x /app/ollama-entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
