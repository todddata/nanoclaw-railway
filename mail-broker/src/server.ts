import { createServer, IncomingMessage, ServerResponse } from 'node:http';

import { verifyCapability } from './capability.js';
import { authorizeAction, parseActionRequest } from './policy.js';

const MAX_BODY_BYTES = 128 * 1024;
const port = Number.parseInt(process.env.PORT || '3000', 10);
const secret = process.env.MAIL_BROKER_CAPABILITY_SECRET || '';
const mode = process.env.MAIL_BROKER_MODE || 'disabled';
const allowedSlackUser = process.env.MAIL_BROKER_SLACK_USER_ID || '';
const allowedSlackChannel = process.env.MAIL_BROKER_SLACK_CHANNEL_ID || '';

const actionCounts = new Map<string, number>();
const idempotencyResults = new Map<string, unknown>();

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
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
  );
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    return json(response, mode === 'disabled' ? 503 : 200, {
      ok: mode !== 'disabled',
      mode,
    });
  }

  if (request.method !== 'POST' || request.url !== '/v1/actions') {
    return json(response, 404, { error: 'not_found' });
  }
  if (mode !== 'mock') {
    return json(response, 503, { error: 'broker_disabled' });
  }
  if (!secret || !allowedSlackUser || !allowedSlackChannel) {
    return json(response, 503, { error: 'broker_not_configured' });
  }

  try {
    const action = parseActionRequest(await readJson(request));
    const capability = verifyCapability(action.capability, secret);
    authorizeAction(action, capability);

    if (
      capability.source.userId !== allowedSlackUser ||
      capability.source.channelId !== allowedSlackChannel
    ) {
      throw new Error('Slack source is outside broker policy');
    }

    const existing = idempotencyResults.get(action.idempotencyKey);
    if (existing) return json(response, 200, existing);

    const actionCount = actionCounts.get(capability.grantId) || 0;
    const requestedActions = Math.max(1, action.messageIds?.length || 0);
    if (actionCount + requestedActions > capability.maxActions) {
      throw new Error('Capability action limit exceeded');
    }
    actionCounts.set(capability.grantId, actionCount + requestedActions);

    // Credential-free staging deliberately records the authorized intent only.
    // Provider adapters are added behind this same policy boundary.
    const result = {
      ok: true,
      mode: 'mock',
      operation: action.operation,
      affected: action.messageIds?.length || 0,
      grantId: capability.grantId,
    };
    idempotencyResults.set(action.idempotencyKey, result);
    audit({
      event: 'mail_action_authorized',
      grantId: capability.grantId,
      taskId: capability.source.taskId,
      userId: capability.source.userId,
      mailboxId: action.mailboxId,
      operation: action.operation,
      reasonCode: action.reasonCode,
      affected: result.affected,
    });
    return json(response, 200, result);
  } catch (error) {
    audit({
      event: 'mail_action_rejected',
      error: error instanceof Error ? error.message : 'unknown_error',
    });
    return json(response, 403, { error: 'request_rejected' });
  }
});

server.listen(port, '0.0.0.0', () => {
  audit({ event: 'mail_broker_started', mode, port });
});
