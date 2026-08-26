import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { AppendOnlyAuditLog, MailAuditInput } from './audit-log.js';
import { brokerHealth, BrokerEngine, BrokerError } from './broker.js';

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
});

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    const health = brokerHealth(mode, killSwitch);
    return json(response, health.status, {
      ...health.body,
      auditPersistent: !!auditLog,
    });
  }

  if (request.method !== 'POST' || request.url !== '/v1/actions') {
    return json(response, 404, { error: 'not_found' });
  }
  if (mode !== 'mock') {
    return json(response, 503, { error: 'broker_disabled' });
  }
  try {
    return json(response, 200, broker.execute(await readJson(request)));
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
