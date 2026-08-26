import { describe, expect, it, vi } from 'vitest';

import {
  MailCleanupConfig,
  neutralizeMailDisplay,
  parseMailCleanupScript,
  parseMailReviewActionScript,
  runMailCleanup,
  runMailReviewAction,
} from './mail-cleanup.js';
import {
  createSignedMailGrantRequest,
  MailBrokerActionRequest,
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
    messageId: 'slack-1',
    issuedAt: '2026-08-25T11:00:00.000Z',
  },
  allowedOperation: 'scheduled_task.execute',
  issuedAt: '2026-08-25T11:00:00.000Z',
  expiresAt: '2026-09-25T11:00:00.000Z',
};
const config: MailCleanupConfig = {
  version: 1,
  type: 'mail_spam_cleanup',
  provider: 'gmail',
  mailboxId: 'pilot@example.com',
  action: 'recoverable_trash_provider_spam',
  maxMessages: 20,
  maxActions: 5,
};

function options(
  overrides: Partial<Parameters<typeof runMailCleanup>[0]> = {},
) {
  return {
    config,
    enabled: true,
    brokerUrl: 'http://mailbroker.railway.internal:8080',
    provenance,
    taskId: 'task-mail-cleanup',
    taskProvenanceSecret: secret,
    now: () => new Date('2026-08-25T12:00:00.000Z'),
    createRunId: () => 'run-20260825-0001',
    ...overrides,
  };
}

describe('mail cleanup script policy', () => {
  it('accepts only the exact bounded cleanup schema', () => {
    expect(parseMailCleanupScript(JSON.stringify(config))).toEqual(config);
    expect(parseMailCleanupScript('echo hello')).toBeNull();
    expect(
      parseMailCleanupScript(JSON.stringify({ type: 'other' })),
    ).toBeNull();
    expect(() =>
      parseMailCleanupScript(
        JSON.stringify({ ...config, url: 'https://evil.test' }),
      ),
    ).toThrow(/invalid/);
    expect(() =>
      parseMailCleanupScript(
        JSON.stringify({ ...config, maxActions: 21, maxMessages: 20 }),
      ),
    ).toThrow(/invalid/);
  });

  it('accepts only opaque bounded review references and neutralizes Slack markup', () => {
    const review = {
      version: 1 as const,
      type: 'mail_review_action' as const,
      provider: 'microsoft' as const,
      mailboxId: 'pilot@example.com',
      action: 'restore' as const,
      reviewRef: 'MR-ABCDEFGHIJKLMNOP',
    };
    expect(parseMailReviewActionScript(JSON.stringify(review))).toEqual(review);
    expect(() =>
      parseMailReviewActionScript(
        JSON.stringify({ ...review, reviewRef: '<@U123>' }),
      ),
    ).toThrow(/invalid/);
    const rendered = neutralizeMailDisplay(
      '<@U123> *ignore* https://evil.test `command` :eyes: 👀 sender@example.test',
    );
    expect(rendered).not.toContain('<@');
    expect(rendered).not.toContain('https://');
    expect(rendered).not.toContain('*');
    expect(rendered).not.toContain('`');
    expect(rendered).not.toContain(':eyes:');
    expect(rendered).not.toContain('👀');
    expect(rendered).not.toContain('example.test');
  });

  it('fails closed before broker access when cleanup is disabled', async () => {
    const exchange = vi.fn();
    await expect(
      runMailCleanup(options({ enabled: false, exchange })),
    ).rejects.toThrow(/disabled/);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('reports without mutation and treats broker records only as scoped data', async () => {
    const exchange = vi.fn(async () => ({
      capability: 'list-capability',
      grantId: 'list-grant',
      expiresAt: '2026-08-25T12:10:00.000Z',
    }));
    const execute = vi.fn(async () => ({
      ok: true as const,
      operation: 'messages.list' as const,
      affected: 2,
      grantId: 'list-grant',
      records: [
        {
          trust: 'untrusted-email-data' as const,
          provider: 'gmail' as const,
          mailboxId: 'pilot@example.com',
          messageId: 'spam-1',
          from: 'spam@example.test',
          subject: 'Offer',
          attachmentsQuarantined: false,
          providerSpam: true,
        },
        {
          trust: 'untrusted-email-data' as const,
          provider: 'gmail' as const,
          mailboxId: 'pilot@example.com',
          messageId: 'human-1',
          from: 'human@example.test',
          subject: 'Hello',
          attachmentsQuarantined: false,
          providerSpam: false,
        },
      ],
    }));
    const result = await runMailCleanup(
      options({
        config: { ...config, action: 'report' },
        exchange,
        execute,
      }),
    );
    expect(result).toMatchObject({
      scanned: 2,
      providerSpamFound: 1,
      movedToRecoverableTrash: 0,
    });
    expect(exchange).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('grants recoverable trash only for exact provider-flagged message IDs', async () => {
    const signedRequests: Array<
      ReturnType<typeof createSignedMailGrantRequest>['request']
    > = [];
    const exchange = vi.fn(
      async (
        _url: string,
        signed: ReturnType<typeof createSignedMailGrantRequest>,
      ) => {
        signedRequests.push(signed.request);
        return {
          capability: signedRequests.length === 1 ? 'list-cap' : 'action-cap',
          grantId: `grant-${signedRequests.length}`,
          expiresAt: '2026-08-25T12:10:00.000Z',
        };
      },
    );
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        operation: 'messages.list',
        affected: 3,
        grantId: 'grant-1',
        records: [
          {
            trust: 'untrusted-email-data',
            provider: 'gmail',
            mailboxId: 'pilot@example.com',
            messageId: 'spam-1',
            from: 'spam1@example.test',
            subject: 'Offer one',
            attachmentsQuarantined: false,
            providerSpam: true,
          },
          {
            trust: 'untrusted-email-data',
            provider: 'gmail',
            mailboxId: 'pilot@example.com',
            messageId: 'human-1',
            from: 'human@example.test',
            subject: 'Hello',
            attachmentsQuarantined: false,
            providerSpam: false,
          },
          {
            trust: 'untrusted-email-data',
            provider: 'gmail',
            mailboxId: 'pilot@example.com',
            messageId: 'spam-2',
            from: 'spam2@example.test',
            subject: 'Offer two',
            attachmentsQuarantined: false,
            providerSpam: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        operation: 'messages.trash',
        affected: 2,
        grantId: 'grant-2',
      });

    const result = await runMailCleanup(options({ exchange, execute }));
    expect(result.movedToRecoverableTrash).toBe(2);
    expect(signedRequests[1]).toMatchObject({
      provider: 'gmail',
      mailboxId: 'pilot@example.com',
      messageIds: ['spam-1', 'spam-2'],
      operations: ['messages.trash'],
      maxActions: 2,
    });
    expect(execute.mock.calls[1]?.[1]).toMatchObject({
      capability: 'action-cap',
      operation: 'messages.trash',
      messageIds: ['spam-1', 'spam-2'],
    });
  });

  it('rejects broker scope confusion and affected-count mismatch', async () => {
    const exchange = vi.fn(async () => ({
      capability: 'capability',
      grantId: 'grant',
      expiresAt: '2026-08-25T12:10:00.000Z',
    }));
    const wrongMailbox = vi.fn(async () => ({
      ok: true as const,
      operation: 'messages.list' as const,
      affected: 1,
      grantId: 'grant',
      records: [
        {
          trust: 'untrusted-email-data' as const,
          provider: 'gmail' as const,
          mailboxId: 'attacker@example.com',
          messageId: 'spam-1',
          from: 'spam@example.test',
          subject: 'Offer',
          attachmentsQuarantined: false,
          providerSpam: true,
        },
      ],
    }));
    await expect(
      runMailCleanup(options({ exchange, execute: wrongMailbox })),
    ).rejects.toThrow(/out-of-scope/);

    const mismatch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        operation: 'messages.list',
        affected: 1,
        grantId: 'grant-1',
        records: [
          {
            trust: 'untrusted-email-data',
            provider: 'gmail',
            mailboxId: 'pilot@example.com',
            messageId: 'spam-1',
            from: 'spam@example.test',
            subject: 'Offer',
            attachmentsQuarantined: false,
            providerSpam: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        operation: 'messages.trash',
        affected: 0,
        grantId: 'grant-2',
      });
    await expect(
      runMailCleanup(options({ exchange, execute: mismatch })),
    ).rejects.toThrow(/affected count/);
  });

  it('resolves an opaque reviewed reference to one exact recoverable action', async () => {
    const exchange = vi.fn(async () => ({
      capability: 'capability',
      grantId: 'grant',
      expiresAt: '2026-08-25T12:10:00.000Z',
    }));
    let executedAction: MailBrokerActionRequest | undefined;
    const execute = vi.fn(
      async (_brokerUrl: string, action: MailBrokerActionRequest) => {
        executedAction = action;
        return {
          ok: true as const,
          operation: 'messages.restore' as const,
          affected: 1,
          grantId: 'grant',
        };
      },
    );
    const updateDisposition = vi.fn();
    const result = await runMailReviewAction({
      config: {
        version: 1,
        type: 'mail_review_action',
        provider: 'microsoft',
        mailboxId: 'pilot@example.com',
        action: 'restore',
        reviewRef: 'MR-ABCDEFGHIJKLMNOP',
      },
      enabled: true,
      brokerUrl: 'http://mailbroker.railway.internal:8080',
      provenance,
      taskId: 'restore-task',
      taskProvenanceSecret: secret,
      now: () => new Date('2026-08-25T12:00:00.000Z'),
      lookupReviewItem: () => ({
        reference: 'MR-ABCDEFGHIJKLMNOP',
        provider: 'microsoft',
        mailbox_id: 'pilot@example.com',
        message_id: 'immutable-message-id',
        disposition: 'recoverable_trash',
        expires_at: '2026-08-30T12:00:00.000Z',
      }),
      updateDisposition,
      exchange,
      execute,
    });
    expect(result.disposition).toBe('restored');
    expect(executedAction).toMatchObject({
      operation: 'messages.restore',
      messageIds: ['immutable-message-id'],
      reasonCode: 'slack_owner_restore',
    });
    expect(updateDisposition).toHaveBeenCalledWith(
      'MR-ABCDEFGHIJKLMNOP',
      'restored',
    );
  });
});
