import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { AppendOnlyAuditLog, MailAuditInput } from './audit-log.js';
import { brokerHealth, BrokerEngine, BrokerError } from './broker.js';
import { exchangeMailGrant } from './grant-exchange.js';
import { googleTokenSource, microsoftTokenSource } from './oauth.js';
import { GmailAdapter, MicrosoftAdapter } from './provider-adapters.js';
import { MailboxAdapter } from './types.js';

const MAX_BODY_BYTES = 128 * 1024;
const port = Number.parseInt(process.env.PORT || '3000', 10);
const secret = process.env.MAIL_BROKER_CAPABILITY_SECRET || '';
const mode = process.env.MAIL_BROKER_MODE || 'disabled';
const allowedSlackUser = process.env.MAIL_BROKER_SLACK_USER_ID || '';
const allowedSlackChannel = process.env.MAIL_BROKER_SLACK_CHANNEL_ID || '';
const killSwitch = process.env.MAIL_BROKER_KILL_SWITCH === 'true';
const revokedGrantIds = (process.env.MAIL_BROKER_REVOKED_GRANT_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const auditPath = process.env.MAIL_BROKER_AUDIT_PATH || '';
const auditLog = auditPath ? new AppendOnlyAuditLog(auditPath) : undefined;
const taskProvenanceSecret =
  process.env.MAIL_BROKER_TASK_PROVENANCE_SECRET || '';
const allowedMailboxIds = new Set(
  (process.env.MAIL_BROKER_MAILBOX_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

function providerAdapter(): MailboxAdapter | undefined {
  const mailboxId = process.env.MAIL_BROKER_PROVIDER_MAILBOX_ID || '';
  if (!mailboxId || !allowedMailboxIds.has(mailboxId)) return undefined;
  if (mode === 'gmail') {
    const clientId = process.env.MAIL_BROKER_GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.MAIL_BROKER_GOOGLE_CLIENT_SECRET || '';
    const refreshToken = process.env.MAIL_BROKER_GOOGLE_REFRESH_TOKEN || '';
    if (!clientId || !clientSecret || !refreshToken) return undefined;
    return new GmailAdapter({
      mailboxId,
      tokenSource: googleTokenSource({
        clientId,
        clientSecret,
        refreshToken,
      }),
    });
  }
  if (mode === 'microsoft') {
    const tenantId = process.env.MAIL_BROKER_MICROSOFT_TENANT_ID || '';
    const clientId = process.env.MAIL_BROKER_MICROSOFT_CLIENT_ID || '';
    const clientSecret = process.env.MAIL_BROKER_MICROSOFT_CLIENT_SECRET || '';
    const refreshToken = process.env.MAIL_BROKER_MICROSOFT_REFRESH_TOKEN || '';
    if (!tenantId || !clientId || !clientSecret || !refreshToken) {
      return undefined;
    }
    return new MicrosoftAdapter({
      mailboxId,
      tokenSource: microsoftTokenSource(tenantId, {
        clientId,
        clientSecret,
        refreshToken,
      }),
    });
  }
  return undefined;
}

const adapter = providerAdapter();
const providerConfigured = mode === 'mock' || !!adapter;
const activeMode = mode === 'mock' || mode === 'gmail' || mode === 'microsoft';

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function audit(event: Record<string, unknown>): void {
  if (
    auditLog &&
    (event.event === 'mail_action_authorized' ||
      event.event === 'mail_action_completed' ||
      event.event === 'mail_action_rejected' ||
      event.event === 'mail_grant_issued' ||
      event.event === 'mail_security_alert')
  ) {
    auditLog.append(event as unknown as MailAuditInput);
  }
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
  );
}

const broker = new BrokerEngine({
  secret,
  allowedSlackUser,
  allowedSlackChannel,
  killSwitch,
  revokedGrantIds,
  audit,
  policyVersion: process.env.MAIL_BROKER_POLICY_VERSION || 'mail-policy-v1',
  modelVersion: process.env.MAIL_BROKER_MODEL_VERSION || 'none',
  denialAlertThreshold: Number.parseInt(
    process.env.MAIL_BROKER_DENIAL_ALERT_THRESHOLD || '5',
    10,
  ),
  adapter,
});

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    const health = brokerHealth(mode, killSwitch, providerConfigured);
    return json(response, health.status, {
      ...health.body,
      auditPersistent: !!auditLog,
      grantExchangeConfigured:
        !!auditLog &&
        taskProvenanceSecret.length >= 32 &&
        allowedMailboxIds.size > 0,
    });
  }

  if (request.method === 'POST' && request.url === '/v1/grants/exchange') {
    if (!activeMode || !providerConfigured || killSwitch || !auditLog) {
      return json(response, 503, { error: 'grant_exchange_disabled' });
    }
    try {
      return json(
        response,
        201,
        exchangeMailGrant(await readJson(request), {
          taskProvenanceSecret,
          capabilitySecret: secret,
          allowedSlackUser,
          allowedSlackChannel,
          allowedMailboxIds,
          isRequestUsed: (requestId) =>
            auditLog?.hasRequestId(requestId) || false,
          audit,
        }),
      );
    } catch (error) {
      try {
        audit({
          event: 'mail_action_rejected',
          outcome: 'rejected',
          reasonCode: 'grant_exchange_rejected',
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      } catch {
        return json(response, 503, { error: 'audit_unavailable' });
      }
      return json(response, 403, { error: 'grant_exchange_rejected' });
    }
  }

  if (request.method !== 'POST' || request.url !== '/v1/actions') {
    return json(response, 404, { error: 'not_found' });
  }
  if (!activeMode || !providerConfigured) {
    return json(response, 503, { error: 'broker_disabled' });
  }
  try {
    return json(response, 200, await broker.execute(await readJson(request)));
  } catch (error) {
    const brokerError = error instanceof BrokerError ? error : undefined;
    if (!brokerError) {
      try {
        audit({
          event: 'mail_action_rejected',
          outcome: 'rejected',
          reasonCode: 'request_rejected',
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      } catch {
        return json(response, 503, { error: 'audit_unavailable' });
      }
    }
    return json(response, brokerError?.status || 403, {
      error: brokerError?.code || 'request_rejected',
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  audit({ event: 'mail_broker_started', mode, killSwitch, port });
});
