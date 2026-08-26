import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  createSignedMailGrantRequest,
  exchangeMailGrant,
} from './mail-grant.js';
import { ScheduledTaskProvenance } from './task-provenance.js';

const secret = 'task-provenance-secret-at-least-32-chars';
const provenance: ScheduledTaskProvenance = {
  version: 1,
  source: {
    version: 1,
    channel: 'slack',
    workspaceId: 'T123',
    channelId: 'C123',
    userId: 'U123',
    messageId: 'slack-message-1',
    issuedAt: '2026-08-25T11:00:00.000Z',
  },
  allowedOperation: 'scheduled_task.execute',
  issuedAt: '2026-08-25T11:00:00.000Z',
  expiresAt: '2026-09-25T11:00:00.000Z',
};

describe('host mail grant exchange', () => {
  it('signs exact provider, mailbox, message, operation, and Slack provenance', () => {
    const signed = createSignedMailGrantRequest(
      provenance,
      'task-1',
      {
        provider: 'gmail',
        mailboxId: 'personal@example.com',
        messageIds: ['message-1'],
        operations: ['messages.trash'],
        maxActions: 1,
      },
      secret,
      new Date('2026-08-25T12:00:00.000Z'),
    );
    expect(signed.request).toMatchObject({
      source: { channelId: 'C123', userId: 'U123', taskId: 'task-1' },
      provider: 'gmail',
      mailboxId: 'personal@example.com',
      messageIds: ['message-1'],
      operations: ['messages.trash'],
    });
    expect(signed.signature).toBe(
      createHmac('sha256', secret)
        .update(JSON.stringify(signed.request))
        .digest('base64url'),
    );
  });

  it('uses only Railway private networking and validates the response', async () => {
    const signed = createSignedMailGrantRequest(
      provenance,
      'task-1',
      {
        provider: 'gmail',
        mailboxId: 'personal@example.com',
        messageIds: ['message-1'],
        operations: ['messages.trash'],
        maxActions: 1,
      },
      secret,
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            capability: 'opaque-capability',
            grantId: 'grant-1',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(
      exchangeMailGrant(
        'http://mailbroker.railway.internal:8080',
        signed,
        fetchMock,
      ),
    ).resolves.toMatchObject({ capability: 'opaque-capability' });
    expect(fetchMock).toHaveBeenCalledOnce();
    await expect(
      exchangeMailGrant('https://evil.example', signed, fetchMock),
    ).rejects.toThrow(/private networking/);
  });
});
