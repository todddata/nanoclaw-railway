#!/bin/sh
set -eu

if [ -n "${MAIL_BROKER_AUDIT_PATH:-}" ]; then
  audit_directory=$(dirname "$MAIL_BROKER_AUDIT_PATH")
  mkdir -p "$audit_directory"
  chown node:node "$audit_directory"
fi

exec setpriv --reuid=node --regid=node --init-groups node dist/server.js
