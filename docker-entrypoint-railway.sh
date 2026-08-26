#!/bin/bash
# Railway entrypoint: fix volume permissions and drop to non-root user
# The /data volume may be root-owned on first mount, so we fix ownership
# before starting the app as the node user.
# claude-code refuses --dangerously-skip-permissions when running as root.

set -e

# Railway may overlay its Node toolchain after the Docker build. Remove every
# package-manager/download surface again in the final runtime namespace before
# the unprivileged host or restricted agent can start.
rm -rf \
  /usr/local/lib/node_modules/npm \
  /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/corepack \
  /usr/local/bin/yarn \
  /usr/local/bin/yarnpkg \
  /usr/local/bin/pnpm \
  /usr/local/bin/pnpx \
  /opt/yarn-v1.22.22

for command_name in npm npx corepack yarn yarnpkg pnpm pnpx git curl; do
  if command -v "$command_name" >/dev/null 2>&1; then
    echo "Refusing to start: forbidden runtime tool is present: $command_name" >&2
    exit 78
  fi
done

# Fix ownership of the data volume (runs as root)
chown -R node:node /data 2>/dev/null || true

# Drop to node user and exec the CMD
exec gosu node "$@"
