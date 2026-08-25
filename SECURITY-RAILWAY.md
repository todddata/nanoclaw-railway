# Railway security profile

This fork deploys NanoClaw as a Slack-only personal assistant on Railway. Railway builds and runs the outer service from `Dockerfile.railway`; it does not provide NanoClaw's normal per-agent Docker boundary inside that service.

## Enforced controls

- Slack messages are accepted only from the configured sender allowlist, before commands or storage.
- Main and non-main conversations require the configured `@NanoClaw` trigger.
- The Railway agent tool profile excludes Bash, subagents, arbitrary MCP servers, skill installation, notebook execution, and remote control.
- Read/search tools are limited to the assigned group, global, and explicit extra workspaces. Writes are limited to the assigned group. Canonical-path checks reject traversal and symlink escapes.
- Scheduled shell scripts and cross-channel `send_message` targets are disabled.
- The agent child receives no Railway service secrets. Anthropic requests use a credential-injecting proxy bound to `127.0.0.1`.
- `/app` and `/agent-runner-dist` are root-owned and read-only at runtime. Persistent state under `/data` is writable by the service account.
- Only Slack production dependencies are installed in the final image. Root, runtime, and agent lockfiles are reproducible with `npm ci`; the base image is digest-pinned.
- Agent result text is not copied into Railway application logs.

## Retention

The service removes inactive session artifacts after seven days, debug/todo files after three days, telemetry after seven days, and group logs after seven days. Override with positive integer values in:

- `SESSION_RETENTION_DAYS`
- `DEBUG_LOG_RETENTION_DAYS`
- `GROUP_LOG_RETENTION_DAYS`

The SQLite message database is not automatically purged. Back it up before schema or routing changes, and establish a separate message-retention policy before handling client information.

## Deployment and rollback

1. Download `/data/store` and `/data/groups` with `railway service files download`.
2. Record the current successful deployment ID.
3. Deploy the candidate and verify Socket Mode connection, owner-only rejection, mention gating, response placeholder replacement, a normal answer, and restart recovery.
4. If verification fails, use Railway's deployment rollback to the recorded successful deployment. Restore `/data/store/messages.db` only if a data migration occurred and only while the service is stopped.

## Remaining architectural limitation

The host orchestrator and agent child still share one Railway service container and Unix account. Tool restrictions and read-only application files substantially reduce reach, but they are not equivalent to a kernel-enforced sandbox. Do not attach high-impact credentials or confidential client data until the agent is moved to a separate sandbox worker or microVM with explicit mounts and network policy.
