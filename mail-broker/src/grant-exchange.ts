import { createHmac, timingSafeEqual } from 'node:crypto';

import { issueCapability } from './capability.js';
import { ALLOWED_OPERATIONS, AllowedOperation, MailProvider } from './types.js';

const SAFE_ID = /^[a-zA-Z0-9@._:+\-=]{1,512}$/;
const SAFE_REQUEST_ID = /^[a-zA-Z0-9._:-]{16,200}$/;

export interface MailGrantRequest {
  version: 1;
  requestId: string;
  source: {
    channel: 'slack';
    workspaceId: string;
    channelId: string;
    userId: string;
    taskId: string;
    messageId: string;
  };
  provider: MailProvider;
  mailboxId: string;
  messageIds: string[];
  operations: AllowedOperation[];
  issuedAt: string;
  expiresAt: string;
  maxActions: number;
}

export interface SignedMailGrantRequest {
  request: MailGrantRequest;
  signature: string;
}

function signature(request: MailGrantRequest, secret: string): Buffer {
  return createHmac('sha256', secret).update(JSON.stringify(request)).digest();
}

export function signMailGrantRequest(
  request: MailGrantRequest,
  secret: string,
): SignedMailGrantRequest {
  if (secret.length < 32)
    throw new Error('Task provenance secret is too short');
  return {
    request,
    signature: signature(request, secret).toString('base64url'),
  };
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

export function parseSignedGrantRequest(
  value: unknown,
): SignedMailGrantRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Grant exchange request must be an object');
  }
  const envelope = value as Record<string, unknown>;
  if (
    !exactKeys(envelope, ['request', 'signature']) ||
    typeof envelope.signature !== 'string'
  ) {
    throw new Error('Invalid grant exchange envelope');
  }
  if (
    !envelope.request ||
    typeof envelope.request !== 'object' ||
    Array.isArray(envelope.request)
  ) {
    throw new Error('Invalid grant request');
  }
  const request = envelope.request as Record<string, unknown>;
  if (
    !exactKeys(request, [
      'version',
      'requestId',
      'source',
      'provider',
      'mailboxId',
      'messageIds',
      'operations',
      'issuedAt',
      'expiresAt',
      'maxActions',
    ]) ||
    request.version !== 1 ||
    typeof request.requestId !== 'string' ||
    !SAFE_REQUEST_ID.test(request.requestId) ||
    (request.provider !== 'gmail' && request.provider !== 'microsoft') ||
    typeof request.mailboxId !== 'string' ||
    !SAFE_ID.test(request.mailboxId) ||
    !Array.isArray(request.messageIds) ||
    request.messageIds.length < 1 ||
    request.messageIds.length > 100 ||
    request.messageIds.some(
      (id) => typeof id !== 'string' || !SAFE_ID.test(id),
    ) ||
    !Array.isArray(request.operations) ||
    request.operations.length < 1 ||
    request.operations.some(
      (operation) =>
        typeof operation !== 'string' ||
        !ALLOWED_OPERATIONS.includes(operation as AllowedOperation),
    ) ||
    typeof request.issuedAt !== 'string' ||
    typeof request.expiresAt !== 'string' ||
    !Number.isInteger(request.maxActions) ||
    (request.maxActions as number) < 1 ||
    (request.maxActions as number) > request.messageIds.length
  ) {
    throw new Error('Invalid grant request');
  }
  if (
    !request.source ||
    typeof request.source !== 'object' ||
    Array.isArray(request.source)
  ) {
    throw new Error('Invalid grant source');
  }
  const source = request.source as Record<string, unknown>;
  if (
    !exactKeys(source, [
      'channel',
      'workspaceId',
      'channelId',
      'userId',
      'taskId',
      'messageId',
    ]) ||
    source.channel !== 'slack' ||
    ['workspaceId', 'channelId', 'userId', 'taskId', 'messageId'].some(
      (key) =>
        typeof source[key] !== 'string' || !SAFE_ID.test(source[key] as string),
    )
  ) {
    throw new Error('Invalid grant source');
  }
  return envelope as unknown as SignedMailGrantRequest;
}

export interface GrantExchangeConfig {
  taskProvenanceSecret: string;
  capabilitySecret: string;
  allowedSlackUser: string;
  allowedSlackChannel: string;
  allowedMailboxIds: Set<string>;
  now?: () => Date;
  isRequestUsed: (requestId: string) => boolean;
  audit: (event: Record<string, unknown>) => void;
}

export function exchangeMailGrant(
  raw: unknown,
  config: GrantExchangeConfig,
): { capability: string; grantId: string; expiresAt: string } {
  if (config.taskProvenanceSecret.length < 32) {
    throw new Error('Grant exchange is not configured');
  }
  const signed = parseSignedGrantRequest(raw);
  const expected = signature(signed.request, config.taskProvenanceSecret);
  const supplied = Buffer.from(signed.signature, 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error('Invalid grant request signature');
  }
  const request = signed.request;
  const now = (config.now?.() || new Date()).getTime();
  const issuedAt = Date.parse(request.issuedAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    issuedAt > now + 60_000 ||
    issuedAt < now - 5 * 60_000 ||
    expiresAt <= now ||
    expiresAt > now + 15 * 60_000
  ) {
    throw new Error('Grant request lifetime is invalid');
  }
  if (
    request.source.userId !== config.allowedSlackUser ||
    request.source.channelId !== config.allowedSlackChannel ||
    !config.allowedMailboxIds.has(request.mailboxId)
  ) {
    throw new Error('Grant request is outside broker policy');
  }
  if (config.isRequestUsed(request.requestId)) {
    throw new Error('Grant request replay rejected');
  }

  const grantId = `grant:${request.requestId}`;
  config.audit({
    event: 'mail_grant_issued',
    outcome: 'authorized',
    requestId: request.requestId,
    grantId,
    taskId: request.source.taskId,
    userId: request.source.userId,
    mailboxId: request.mailboxId,
    messageRefs: request.messageIds,
    operation: request.operations.join(','),
    reasonCode: 'signed_slack_task_grant',
    policyVersion: 'mail-policy-v1',
    modelVersion: 'none',
    affected: request.messageIds.length,
  });
  return {
    capability: issueCapability(
      {
        version: 1,
        grantId,
        source: {
          channel: 'slack',
          workspaceId: request.source.workspaceId,
          channelId: request.source.channelId,
          userId: request.source.userId,
          taskId: request.source.taskId,
        },
        mailboxIds: [request.mailboxId],
        providers: [request.provider],
        messageIds: request.messageIds,
        operations: request.operations,
        issuedAt: request.issuedAt,
        expiresAt: request.expiresAt,
        maxActions: request.maxActions,
      },
      config.capabilitySecret,
    ),
    grantId,
    expiresAt: request.expiresAt,
  };
}
