import { createHmac, timingSafeEqual } from 'node:crypto';

import { ALLOWED_OPERATIONS, CapabilityPayload } from './types.js';

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(encodedPayload: string, secret: string): string {
  return encode(createHmac('sha256', secret).update(encodedPayload).digest());
}

export function issueCapability(
  payload: CapabilityPayload,
  secret: string,
): string {
  if (secret.length < 32) throw new Error('Capability secret is too short');
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifyCapability(
  token: string,
  secret: string,
  now = new Date(),
): CapabilityPayload {
  if (secret.length < 32) throw new Error('Capability secret is too short');
  const [encodedPayload, suppliedSignature, extra] = token.split('.');
  if (!encodedPayload || !suppliedSignature || extra !== undefined) {
    throw new Error('Malformed capability');
  }

  const expected = sign(encodedPayload, secret);
  const suppliedBytes = Buffer.from(suppliedSignature);
  const expectedBytes = Buffer.from(expected);
  if (
    suppliedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new Error('Invalid capability signature');
  }

  const payload = JSON.parse(
    Buffer.from(encodedPayload, 'base64url').toString('utf8'),
  ) as CapabilityPayload;

  if (
    payload.version !== 1 ||
    payload.source?.channel !== 'slack' ||
    !payload.source.workspaceId ||
    !payload.source.channelId ||
    !payload.source.userId ||
    !payload.source.taskId ||
    !payload.grantId ||
    !Array.isArray(payload.mailboxIds) ||
    !Array.isArray(payload.messageIds) ||
    payload.messageIds.length > 100 ||
    payload.messageIds.some(
      (messageId) => typeof messageId !== 'string' || !messageId || messageId.length > 512,
    ) ||
    !Array.isArray(payload.operations) ||
    payload.operations.some(
      (operation) => !ALLOWED_OPERATIONS.includes(operation),
    ) ||
    !Number.isInteger(payload.maxActions) ||
    payload.maxActions < 1
  ) {
    throw new Error('Invalid capability payload');
  }

  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    throw new Error('Invalid capability lifetime');
  }
  if (issuedAt > now.getTime() + 60_000 || expiresAt <= now.getTime()) {
    throw new Error('Capability is not currently valid');
  }

  return payload;
}
