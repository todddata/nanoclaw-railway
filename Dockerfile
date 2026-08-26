# NanoClaw Railway Deployment
# Multi-stage build: agent-runner + host orchestrator in a single image

# Stage 1: Build agent-runner
FROM node:22-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS agent-builder

WORKDIR /build/agent-runner
COPY container/agent-runner/package*.json ./
RUN npm ci
COPY container/agent-runner/ ./
RUN npm run build

# Stage 2: Build host orchestrator
FROM node:22-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS host-builder

WORKDIR /build/host
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 3: Install only the Slack production dependency set.
FROM node:22-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96 AS runtime-deps

WORKDIR /build/runtime
COPY railway-runtime/package*.json ./
RUN npm ci --omit=dev

# Stage 4: Final image
FROM node:22-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96

# The restricted Railway runtime does not ship a browser, package manager,
# source-control client, or network CLI. Railway skill synchronization is
# disabled; all runtime code and dependencies are immutable image contents.
RUN apt-get update && apt-get install -y \
    gosu \
    && rm -rf /var/lib/apt/lists/* \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /usr/local/bin/pnpm \
    /usr/local/bin/pnpx

# Copy agent-runner build output
COPY --from=agent-builder /build/agent-runner/dist /agent-runner-dist
COPY --from=agent-builder /build/agent-runner/node_modules /agent-runner-dist/node_modules
COPY --from=agent-builder /build/agent-runner/package.json /agent-runner-dist/package.json

# Copy host orchestrator
WORKDIR /app
COPY --from=host-builder /build/host/dist ./dist/
COPY --from=runtime-deps /build/runtime/node_modules ./node_modules/
COPY railway-runtime/package.json ./package.json

# Copy runtime files needed by the host
COPY container/skills/ ./container/skills/
COPY groups/ ./groups/
COPY setup/ ./setup/
COPY scripts/ ./scripts/
COPY CLAUDE.md ./

# Set agent-runner path for railway-runner.ts
ENV AGENT_RUNNER_PATH=/agent-runner-dist/index.js

# Default volume mount path (Railway volumes)
ENV RAILWAY_VOLUME_MOUNT_PATH=/data
ENV NANOCLAW_CHANNELS=slack
ENV CREDENTIAL_PROXY_HOST=127.0.0.1

# Create data directories and set up non-root user (node user from base image)
# claude-code refuses --dangerously-skip-permissions when running as root
RUN mkdir -p /data/store /data/groups /data/data && \
    chown -R node:node /data /home/node && \
    chown -R root:root /app /agent-runner-dist && \
    chmod -R a-w /app /agent-runner-dist

# Entrypoint fixes volume permissions (volume may be root-owned on first mount)
# then drops to non-root user
COPY docker-entrypoint-railway.sh /docker-entrypoint-railway.sh
RUN chmod +x /docker-entrypoint-railway.sh

# Assert the final filesystem, after every cross-stage COPY. A stale or
# incorrectly cached Railway layer must fail the build instead of publishing a
# runtime with tools that can fetch or install code.
RUN rm -rf \
      /usr/local/lib/node_modules/npm \
      /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/corepack \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
    && ! command -v npm \
    && ! command -v npx \
    && ! command -v corepack \
    && ! command -v yarn \
    && ! command -v pnpm \
    && ! command -v git \
    && ! command -v curl

ENTRYPOINT ["/docker-entrypoint-railway.sh"]
CMD ["node", "dist/index.js"]
