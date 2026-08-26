import assert from 'node:assert/strict';
import test from 'node:test';

import { issueCapability, verifyCapability } from './capability.js';
import { CapabilityPayload } from './types.js';

const secret = 'a'.repeat(32);

function payload(
  overrides: Partial<CapabilityPayload> = {},
): CapabilityPayload {
  return {
    version: 1,
    grantId: 'grant-1',
    source: {
      channel: 'slack',
      workspaceId: 'T123',
      channelId: 'C123',
      userId: 'U123',
      taskId: 'task-1',
    },
    mailboxIds: ['mailbox@example.com'],
    operations: ['messages.list', 'messages.trash'],
    issuedAt: '2026-08-25T12:00:00.000Z',
    expiresAt: '2026-08-25T13:00:00.000Z',
    maxActions: 10,
    ...overrides,
  };
}

test('issues and verifies a Slack-scoped capability', () => {
  const token = issueCapability(payload(), secret);
  const verified = verifyCapability(
    token,
    secret,
    new Date('2026-08-25T12:30:00.000Z'),
  );
  assert.equal(verified.source.channel, 'slack');
  assert.deepEqual(verified.operations, ['messages.list', 'messages.trash']);
});

test('rejects tampering and expired capabilities', () => {
  const token = issueCapability(payload(), secret);
  assert.throws(() => verifyCapability(`${token}x`, secret), /signature/);
  assert.throws(
    () => verifyCapability(token, secret, new Date('2026-08-25T13:00:00.000Z')),
    /not currently valid/,
  );
});

test('rejects non-Slack provenance', () => {
  const unsafe = payload();
  (unsafe.source as { channel: string }).channel = 'email';
  const token = issueCapability(unsafe, secret);
  assert.throws(
    () => verifyCapability(token, secret, new Date('2026-08-25T12:30:00Z')),
    /Invalid capability payload/,
  );
});
