# NanoClaw mailbox broker

This service is the security boundary between NanoClaw and mailbox providers.
Email is always untrusted data; it is never accepted as a command source.

## Security invariants

- Only a short-lived, HMAC-signed capability with Slack provenance can authorize
  a mailbox action.
- Production policy pins the capability to Todd's Slack user ID and the private
  NanoClaw channel ID.
- The API has no send, forward, reply, arbitrary URL, raw provider API, or
  permanent-delete operation.
- Request bodies have a strict schema and size limit. Unknown fields fail closed.
- Each grant has an action ceiling, and retries require an idempotency key.
- Operators can immediately stop all actions with `MAIL_BROKER_KILL_SWITCH=true`
  or revoke individual grants with `MAIL_BROKER_REVOKED_GRANT_IDS`.
- HTML, external links, remote images, and attachments are converted into inert,
  explicitly untrusted records before classification.
- Model-only spam decisions quarantine for seven days. Provider spam or an
  explicit blocklist may move to recoverable trash. Sensitive or uncertain mail
  goes to review.
- Classifier output is a three-field schema (classification, confidence, and
  approved model version) with no tools or credentials. Per-mailbox allowlists,
  blocklists, sensitive-topic protection, confidence thresholds, and run quotas
  are enforced outside the classifier.
- Non-list capabilities bind exact message IDs as well as mailbox, operation,
  Slack provenance, expiry, and quota. A classifier cannot mint or widen them.
- NanoClaw signs exact ten-minute grant requests with its scheduled-task
  provenance key. The broker checks owner/channel/mailbox scope and durable
  replay state, then issues the usable capability with a separate broker-only
  signing key that NanoClaw and the model never receive.
- Email fields are normalized as explicitly untrusted data. Active HTML and
  external links are removed; attachments, calendar parts, embedded messages,
  and archives are quarantined without being opened.
- Ingestion rejects more than 10 MiB raw input, 200 MIME parts, 12 levels of
  nesting, 25 MiB expanded content, 10 encoding errors, 50 attachments, or 200
  headers.
- Mailbox intent is written to a hash-chained, mode-0600 journal before any
  adapter mutation. A required audit-write failure prevents the action.

## Staging mode

`MAIL_BROKER_MODE=mock` validates and audits actions without connecting to a
mailbox. Its stateful provider simulator exercises quarantine, recoverable
trash/deleted-items, and restore behavior. Keep Railway in this mode until one
pilot mailbox has been explicitly selected and authorized.

Required staging variables:

- `MAIL_BROKER_CAPABILITY_SECRET` (at least 32 random characters)
- `MAIL_BROKER_SLACK_USER_ID`
- `MAIL_BROKER_SLACK_CHANNEL_ID`
- `MAIL_BROKER_AUDIT_PATH` (production: `/data/mail-audit.jsonl` on a dedicated
  broker-only Railway volume)
- `MAIL_BROKER_TASK_PROVENANCE_SECRET` (same host provenance verifier key; not
  the broker capability-signing key)
- `MAIL_BROKER_MAILBOX_IDS` (comma-separated explicit mailbox allowlist)

## Provider modes

The broker implements fixed-surface `gmail` and `microsoft` modes. Both verify
the authenticated account identity against `MAIL_BROKER_PROVIDER_MAILBOX_ID`
before reading a message. Provider URLs are constants, redirects are rejected,
attachments are never downloaded, and provider error bodies are never returned
or logged. The OAuth refresh token and client credential belong only on the
MailBroker service; never copy them to NanoClaw or expose them to the model.

For Gmail, set `MAIL_BROKER_MODE=gmail`,
`MAIL_BROKER_PROVIDER_MAILBOX_ID`, `MAIL_BROKER_GOOGLE_CLIENT_ID`,
`MAIL_BROKER_GOOGLE_CLIENT_SECRET`, and `MAIL_BROKER_GOOGLE_REFRESH_TOKEN`.
The fixed scope is `gmail.modify`. The adapter supports list/get, label changes,
trash, and untrash; it has no send or permanent-delete route.

For Microsoft 365, set `MAIL_BROKER_MODE=microsoft`,
`MAIL_BROKER_PROVIDER_MAILBOX_ID`, `MAIL_BROKER_MICROSOFT_TENANT_ID`,
`MAIL_BROKER_MICROSOFT_CLIENT_ID`, `MAIL_BROKER_MICROSOFT_CLIENT_SECRET`, and
`MAIL_BROKER_MICROSOFT_REFRESH_TOKEN`. The fixed delegated permissions are
`Mail.ReadWrite` and `User.Read`. The adapter supports list/get, categories,
and recoverable moves to Deleted Items or Inbox; it has no delete, send, reply,
or forward route.

If any required provider variable is absent, the health and action endpoints
fail closed with `503`. Provider activation also requires the selected mailbox
to appear in `MAIL_BROKER_MAILBOX_IDS`.

Optional safety controls:

- `MAIL_BROKER_KILL_SWITCH=true` blocks every action with `503`. The health
  endpoint remains live and reports `actionsEnabled: false`, so Railway can
  activate the emergency deployment instead of retaining an older container.
  Set it first during any suspected compromise.
- `MAIL_BROKER_REVOKED_GRANT_IDS=grant-1,grant-2` denies named signed grants
  without rotating the service-wide signing secret.
- `MAIL_BROKER_DENIAL_ALERT_THRESHOLD=5` emits a structured security alert after
  repeated denials in a one-minute window.
- `MAIL_BROKER_POLICY_VERSION` and `MAIL_BROKER_MODEL_VERSION` are copied into
  audit events for traceability; message bodies and tokens are never journaled.

Emergency sequence: enable the kill switch, revoke or rotate the affected
credential, inspect the structured audit log, then redeploy with the kill switch
disabled only after the incident is understood. The API intentionally cannot
send mail or permanently delete messages.

Without the required mode configuration, the action endpoint returns `503`.
