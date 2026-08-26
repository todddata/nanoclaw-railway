# Railway Hardening and Recovery Runbook

This runbook is for the Data Methods NanoClaw deployment. Never paste token or
secret values into an issue, pull request, log, chat, or command transcript.

## Production boundaries

- Slack private channel is the only command plane.
- The sender allowlist must contain only Todd's immutable Slack user ID and use
  `drop` mode for all other users and bots.
- Mail is data, never a command source. The agent receives no Microsoft OAuth
  token, Entra client secret, mailbox password, or arbitrary Graph URL.
- MailBroker permits bounded reports, provider-spam moves to recoverable trash,
  and exact opaque-reference restoration. Sending, forwarding, rules, and
  permanent deletion are denied.
- The host-persisted mail kill switch overrides every report and mutation.

## Required Slack permissions

Bot events: `message.groups` only.

Bot OAuth scopes:

- `chat:write` — reply in the private command channel.
- `groups:history` — receive private-channel messages.
- `groups:read` — resolve private-channel metadata for registered groups.
- `users:read` — resolve display names only; authorization never uses names.

Do not grant public-channel or DM history/read scopes. The app-level Socket Mode
token needs `connections:write` only.

## Required deployment variables

NanoClaw requires the Slack tokens, Anthropic key, task-provenance secret,
MailBroker private URL, exact pilot mailbox/provider, private channel ID, and a
drop-mode sender allowlist. MailBroker separately owns Microsoft OAuth material,
its expected mailbox identity, the same grant-verification secret, and its audit
volume. Do not copy MailBroker OAuth material into NanoClaw.

## Verification after every deployment

Railway must report the deployment healthy through `GET /healthz`. The check
returns success only while Slack is connected, the Anthropic credential is
configured, the exact owner-only Slack control plane is registered, and, when
mailbox automation is enabled, both the agent mailbox profile and MailBroker's
persistent audit plus signed-grant exchange are ready. It never returns
credentials, provider URLs, mailbox identifiers, or mailbox contents.

1. Confirm the GitHub `verify` check passed for the exact deployed commit.
2. Confirm both Railway services are running one replica and their volumes are
   mounted.
3. Confirm NanoClaw connects to the expected Slack workspace and bot identity.
4. Send a report-only mailbox status/scan command from Todd's Slack account.
5. Confirm a non-owner message or bot message produces no task and no reply.
6. Confirm MailBroker audit-chain verification succeeds and the report shows no
   mailbox mutation.
7. For a release that changes mail actions, move one review reference to
   recoverable trash, restore it, and verify both audit entries.

## Credential rotation

Rotate one credential class at a time so failures are attributable.

1. Create the replacement in Anthropic, Slack, or Entra.
2. Update only the owning Railway service variable.
3. Redeploy and complete the verification checklist above.
4. Revoke the old credential immediately after the replacement succeeds.
5. Record only the rotation time, credential class, owner, and verification
   result. Never record secret values or recoverable fragments.

For Slack, rotate the bot token and Socket Mode app token separately. Reinstall
the app after changing OAuth scopes, update the Railway bot token, verify Socket
Mode reconnects, then revoke the previous app-level token.

## Emergency response

If mail behavior is unexpected, first enable the mail kill switch from Todd's
authorized Slack account. If Slack identity or command authorization is in
doubt, stop the NanoClaw Railway service. If mailbox OAuth is in doubt, revoke
the Entra session/secret and stop MailBroker. Preserve the persistent audit
volume and Railway logs; do not delete evidence during containment.

## Rollback

1. Identify the last GitHub commit whose required `verify` check succeeded and
   whose live Slack/mail acceptance test was recorded.
2. Redeploy that exact Railway deployment or commit without changing volumes.
3. Keep the mail kill switch enabled until report-only verification succeeds.
4. Resume bounded mail actions only after identity, audit chain, and exact-item
   restore tests pass.

Rollback never includes restoring an old exposed credential. Generate a new
credential and attach it to the known-good code instead.
