import {
  ALLOWED_OPERATIONS,
  BrokerActionRequest,
  CapabilityPayload,
} from './types.js';

const SAFE_ID = /^[a-zA-Z0-9@._:+\-=]{1,512}$/;
const SAFE_REASON = /^[a-z0-9_.-]{1,64}$/;
const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{8,200}$/;
const SAFE_LABEL = /^[^\u0000-\u001f\u007f]{1,128}$/;

export function parseActionRequest(value: unknown): BrokerActionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request must be an object');
  }
  const input = value as Record<string, unknown>;
  const permittedKeys = new Set([
    'capability',
    'operation',
    'provider',
    'mailboxId',
    'messageIds',
    'addLabels',
    'removeLabels',
    'reasonCode',
    'idempotencyKey',
  ]);
  if (Object.keys(input).some((key) => !permittedKeys.has(key))) {
    throw new Error('Unknown request field');
  }

  if (
    typeof input.capability !== 'string' ||
    typeof input.operation !== 'string' ||
    !ALLOWED_OPERATIONS.includes(
      input.operation as (typeof ALLOWED_OPERATIONS)[number],
    ) ||
    (input.provider !== 'gmail' && input.provider !== 'microsoft') ||
    typeof input.mailboxId !== 'string' ||
    !SAFE_ID.test(input.mailboxId) ||
    typeof input.reasonCode !== 'string' ||
    !SAFE_REASON.test(input.reasonCode) ||
    typeof input.idempotencyKey !== 'string' ||
    !SAFE_IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    throw new Error('Invalid request');
  }

  const readStringArray = (
    field: 'messageIds' | 'addLabels' | 'removeLabels',
    pattern: RegExp,
    maximum: number,
  ): string[] | undefined => {
    const raw = input[field];
    if (raw === undefined) return undefined;
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > maximum ||
      raw.some((item) => typeof item !== 'string' || !pattern.test(item))
    ) {
      throw new Error(`Invalid ${field}`);
    }
    return [...new Set(raw as string[])];
  };

  return {
    capability: input.capability,
    operation: input.operation as BrokerActionRequest['operation'],
    provider: input.provider,
    mailboxId: input.mailboxId,
    messageIds: readStringArray('messageIds', SAFE_ID, 100),
    addLabels: readStringArray('addLabels', SAFE_LABEL, 20),
    removeLabels: readStringArray('removeLabels', SAFE_LABEL, 20),
    reasonCode: input.reasonCode,
    idempotencyKey: input.idempotencyKey,
  };
}

export function authorizeAction(
  request: BrokerActionRequest,
  capability: CapabilityPayload,
): void {
  if (!capability.mailboxIds.includes(request.mailboxId)) {
    throw new Error('Mailbox is outside capability scope');
  }
  if (!capability.operations.includes(request.operation)) {
    throw new Error('Operation is outside capability scope');
  }

  const needsMessageIds = !['messages.list'].includes(request.operation);
  if (needsMessageIds && !request.messageIds?.length) {
    throw new Error('Message IDs are required');
  }
  if (request.operation !== 'messages.modify_labels') {
    if (request.addLabels || request.removeLabels) {
      throw new Error('Labels are only valid for messages.modify_labels');
    }
  }
}
