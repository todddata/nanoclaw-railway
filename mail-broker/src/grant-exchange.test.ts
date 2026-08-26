import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyCapability } from './capability.js';
import {
  exchangeMailGrant,
  MailGrantRequest,
  signMailGrantRequest,
} from './grant-exchange.js';

const taskSecret = 'task-provenance-secret-at-least-32-chars';
const capabilitySecret = 'c'.repeat(32);
const now = new Date('2026-08-25T12:00:00.000Z');

function request(overrides: Partial<MailGrantRequest> = {}): MailGrantRequest {
  return {
    version: 1,
    requestId: 'request-20260825-0001',
    source: {
      channel: 'slack',
      workspaceId: 'T123',
      channelId: 'C123',
      userId: 'U123',
      taskId: 'task-1',
      messageId: 'slack-message-1',
    },
    provider: 'gmail',
    mailboxId: 'personal@example.com',
    messageIds: ['message-1'],
    operations: ['messages.trash'],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    maxActions: 1,
    ...overrides,
  };
}

function setup() {
  const used = new Set<string>();
  const events: Record<string, unknown>[] = [];
  const config = {
    taskProvenanceSecret: taskSecret,
    capabilitySecret,
    allowedSlackUser: 'U123',
    allowedSlackChannel: 'C123',
    allowedMailboxIds: new Set(['personal@example.com']),
    now: () => now,
    isRequestUsed: (requestId: string) => used.has(requestId),
    audit: (event: Record<string, unknown>) => {
      events.push(event);
      if (typeof event.requestId === 'string') used.add(event.requestId);
    },
  };
  return { used, events, config };
}

test('exchanges a host-signed request without exposing the capability key', () => {
  const { events, config } = setup();
  const result = exchangeMailGrant(
    signMailGrantRequest(request(), taskSecret),
    config,
  );
  const payload = verifyCapability(result.capability, capabilitySecret, now);
  assert.deepEqual(payload.providers, ['gmail']);
  assert.deepEqual(payload.mailboxIds, ['personal@example.com']);
  assert.deepEqual(payload.messageIds, ['message-1']);
  assert.deepEqual(payload.operations, ['messages.trash']);
  assert.equal(events[0]?.event, 'mail_grant_issued');
  assert.equal(events[0]?.requestId, 'request-20260825-0001');
});

test('rejects replay, signature tampering, wrong owner/channel, and mailbox escalation', () => {
  const { config } = setup();
  const signed = signMailGrantRequest(request(), taskSecret);
  exchangeMailGrant(signed, config);
  assert.throws(() => exchangeMailGrant(signed, config), /replay/);

  const tampered = signMailGrantRequest(
    request({ requestId: 'request-20260825-0002' }),
    taskSecret,
  );
  tampered.request.messageIds = ['message-other'];
  assert.throws(() => exchangeMailGrant(tampered, setup().config), /signature/);

  for (const unsafe of [
    request({
      requestId: 'request-20260825-0003',
      source: { ...request().source, userId: 'U_ATTACKER' },
    }),
    request({
      requestId: 'request-20260825-0004',
      source: { ...request().source, channelId: 'C_OTHER' },
    }),
    request({
      requestId: 'request-20260825-0005',
      mailboxId: 'other@example.com',
    }),
  ]) {
    assert.throws(
      () =>
        exchangeMailGrant(
          signMailGrantRequest(unsafe, taskSecret),
          setup().config,
        ),
      /outside broker policy/,
    );
  }
});

test('rejects stale, long-lived, over-quota, and unknown-field requests', () => {
  const { config } = setup();
  assert.throws(
    () =>
      exchangeMailGrant(
        signMailGrantRequest(
          request({
            requestId: 'request-20260825-0006',
            expiresAt: new Date(now.getTime() + 16 * 60_000).toISOString(),
          }),
          taskSecret,
        ),
        config,
      ),
    /lifetime/,
  );
  assert.throws(
    () =>
      signMailGrantRequest(
        request({
          requestId: 'request-20260825-0007',
          maxActions: 2,
        }),
        taskSecret,
      ) &&
      exchangeMailGrant(
        signMailGrantRequest(
          request({ requestId: 'request-20260825-0007', maxActions: 2 }),
          taskSecret,
        ),
        config,
      ),
    /Invalid grant request/,
  );
  const withUnknown = {
    ...signMailGrantRequest(
      request({ requestId: 'request-20260825-0008' }),
      taskSecret,
    ),
    url: 'http://169.254.169.254/latest/meta-data',
  };
  assert.throws(() => exchangeMailGrant(withUnknown, config), /envelope/);
});
