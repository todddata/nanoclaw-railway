import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeAction, parseActionRequest } from './policy.js';
import { BrokerActionRequest, CapabilityPayload } from './types.js';

const request: BrokerActionRequest = {
  capability: 'token',
  operation: 'messages.trash',
  provider: 'gmail',
  mailboxId: 'mailbox@example.com',
  messageIds: ['message-1'],
  reasonCode: 'provider_spam',
  idempotencyKey: 'request-1234',
};

const capability: CapabilityPayload = {
  version: 1,
  grantId: 'grant-1',
  source: {
    channel: 'slack',
    workspaceId: 'T1',
    channelId: 'C1',
    userId: 'U1',
    taskId: 'task-1',
  },
  mailboxIds: ['mailbox@example.com'],
  messageIds: ['message-1'],
  operations: ['messages.trash'],
  issuedAt: new Date(Date.now() - 1_000).toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  maxActions: 1,
};

test('accepts a strictly shaped authorized request', () => {
  const parsed = parseActionRequest(request);
  assert.doesNotThrow(() => authorizeAction(parsed, capability));
});

test('rejects unknown fields and non-allowlisted operations', () => {
  assert.throws(
    () => parseActionRequest({ ...request, url: 'https://evil.example' }),
    /Unknown request field/,
  );
  assert.throws(
    () => parseActionRequest({ ...request, operation: 'messages.send' }),
    /Invalid request/,
  );
});

test('rejects mailbox and operation scope escalation', () => {
  assert.throws(
    () =>
      authorizeAction(
        { ...request, mailboxId: 'other@example.com' },
        capability,
      ),
    /outside capability scope/,
  );
  assert.throws(
    () =>
      authorizeAction(
        { ...request, operation: 'messages.untrash' },
        capability,
      ),
    /outside capability scope/,
  );
  assert.throws(
    () =>
      authorizeAction(
        { ...request, messageIds: ['message-2'] },
        capability,
      ),
    /outside capability scope/,
  );
});
