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
- HTML, external links, remote images, and attachments are converted into inert,
  explicitly untrusted records before classification.
- Model-only spam decisions quarantine for seven days. Provider spam or an
  explicit blocklist may move to recoverable trash. Sensitive or uncertain mail
  goes to review.

## Staging mode

`MAIL_BROKER_MODE=mock` validates and audits actions without connecting to a
mailbox. This is the only implemented runtime mode until provider adapters and
their adversarial tests are complete.

Required staging variables:

- `MAIL_BROKER_CAPABILITY_SECRET` (at least 32 random characters)
- `MAIL_BROKER_SLACK_USER_ID`
- `MAIL_BROKER_SLACK_CHANNEL_ID`

Without all three values, the action endpoint returns `503`.
