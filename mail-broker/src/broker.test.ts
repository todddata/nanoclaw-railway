import assert from 'node:assert/strict';
import test from 'node:test';

import { BrokerEngine } from './broker.js';
import { issueCapability } from './capability.js';
import { MockMailboxAdapter } from './mock-adapter.js';
import {
  AllowedOperation,
  BrokerActionRequest,
  CapabilityPayload,
  MailProvider,
  MockMessageView,
} from './types.js';

const secret = 'test-secret-that-is-at-least-32-characters';
const now = new Date('2026-08-25T12:30:00.000Z');
const gmailMessage: MockMessageView = {
  provider: 'gmail',
  mailboxId: 'personal@example.com',
  messageId: 'gmail-1',
  labels: ['INBOX'],
  location: 'inbox',
};
const microsoftMessage: MockMessageView = {
  provider: 'microsoft',
  mailboxId: 'work@example.com',
  messageId: 'outlook-1',
  labels: [],
  location: 'inbox',
};

function capability(
  operations: AllowedOperation[],
  overrides: Partial<CapabilityPayload> = {},
): string {
  return issueCapability(
    {
      version: 1,
      grantId: 'grant-1',
      source: {
        channel: 'slack',
        workspaceId: 'T123',
        channelId: 'C123',
        userId: 'U123',
        taskId: 'task-1',
      },
      mailboxIds: ['personal@example.com', 'work@example.com'],
      operations,
      issuedAt: '2026-08-25T12:00:00.000Z',
      expiresAt: '2026-08-25T13:00:00.000Z',
      maxActions: 20,
      ...overrides,
    },
    secret,
  );
}

function request(
  token: string,
  operation: AllowedOperation,
  provider: MailProvider,
  mailboxId: string,
  messageId: string,
  idempotencyKey: string,
  extra: Partial<BrokerActionRequest> = {},
): BrokerActionRequest {
  return {
    capability: token,
    operation,
    provider,
    mailboxId,
    messageIds: [messageId],
    reasonCode: 'test.authorized',
    idempotencyKey,
    ...extra,
  };
}

function engine(adapter = new MockMailboxAdapter([gmailMessage, microsoftMessage])) {
  return new BrokerEngine({
    secret,
    allowedSlackUser: 'U123',
    allowedSlackChannel: 'C123',
    adapter,
    now: () => now,
  });
}

test('executes recoverable Gmail quarantine, trash, and restore end to end', () => {
  const broker = engine();
  const token = capability([
    'messages.modify_labels',
    'messages.trash',
    'messages.untrash',
  ]);

  broker.execute(
    request(
      token,
      'messages.modify_labels',
      'gmail',
      'personal@example.com',
      'gmail-1',
      'gmail-label-001',
      { addLabels: ['NanoClaw/Quarantine'], removeLabels: ['INBOX'] },
    ),
  );
  broker.execute(
    request(
      token,
      'messages.trash',
      'gmail',
      'personal@example.com',
      'gmail-1',
      'gmail-trash-001',
    ),
  );
  assert.equal(broker.adapter.snapshot()[0]?.location, 'trash');

  broker.execute(
    request(
      token,
      'messages.untrash',
      'gmail',
      'personal@example.com',
      'gmail-1',
      'gmail-restore-001',
    ),
  );
  const restored = broker.adapter.snapshot()[0];
  assert.equal(restored?.location, 'inbox');
  assert.deepEqual(restored?.labels, ['NanoClaw/Quarantine']);
});

test('executes recoverable Microsoft delete and restore end to end', () => {
  const broker = engine();
  const token = capability(['messages.move_deleted', 'messages.restore']);
  broker.execute(
    request(
      token,
      'messages.move_deleted',
      'microsoft',
      'work@example.com',
      'outlook-1',
      'outlook-delete-001',
    ),
  );
  assert.equal(broker.adapter.snapshot()[1]?.location, 'deleted');
  broker.execute(
    request(
      token,
      'messages.restore',
      'microsoft',
      'work@example.com',
      'outlook-1',
      'outlook-restore-001',
    ),
  );
  assert.equal(broker.adapter.snapshot()[1]?.location, 'inbox');
});

test('scopes idempotency to a grant and performs one side effect', () => {
  class CountingAdapter extends MockMailboxAdapter {
    calls = 0;
    override execute(action: BrokerActionRequest) {
      this.calls += 1;
      return super.execute(action);
    }
  }
  const adapter = new CountingAdapter([gmailMessage]);
  const broker = engine(adapter);
  const token = capability(['messages.trash']);
  const action = request(
    token,
    'messages.trash',
    'gmail',
    'personal@example.com',
    'gmail-1',
    'idempotent-trash-001',
  );
  broker.execute(action);
  broker.execute(action);
  assert.equal(adapter.calls, 1);
});

test('rejects revoked grants, over-quota actions, and wrong-provider operations', () => {
  const revoked = new BrokerEngine({
    secret,
    allowedSlackUser: 'U123',
    allowedSlackChannel: 'C123',
    revokedGrantIds: ['grant-1'],
    now: () => now,
  });
  const trashToken = capability(['messages.trash']);
  const trash = request(
    trashToken,
    'messages.trash',
    'gmail',
    'personal@example.com',
    'gmail-1',
    'revoked-trash-001',
  );
  assert.throws(() => revoked.execute(trash), /revoked/);

  const quotaBroker = engine();
  const quotaToken = capability(['messages.trash'], { maxActions: 1 });
  quotaBroker.execute({ ...trash, capability: quotaToken, idempotencyKey: 'quota-trash-001' });
  assert.throws(
    () =>
      quotaBroker.execute({
        ...trash,
        capability: quotaToken,
        idempotencyKey: 'quota-trash-002',
      }),
    /limit exceeded/,
  );

  const providerBroker = engine();
  const wrongProviderToken = capability(['messages.trash']);
  assert.throws(
    () =>
      providerBroker.execute(
        request(
          wrongProviderToken,
          'messages.trash',
          'microsoft',
          'work@example.com',
          'outlook-1',
          'wrong-provider-001',
        ),
      ),
    /not valid for Microsoft/,
  );
});

test('kill switch rejects every action before any side effect', () => {
  class CountingAdapter extends MockMailboxAdapter {
    calls = 0;
    override execute(action: BrokerActionRequest) {
      this.calls += 1;
      return super.execute(action);
    }
  }
  const adapter = new CountingAdapter([gmailMessage]);
  const broker = new BrokerEngine({
    secret,
    allowedSlackUser: 'U123',
    allowedSlackChannel: 'C123',
    killSwitch: true,
    adapter,
    now: () => now,
  });
  const token = capability(['messages.trash']);
  assert.throws(
    () =>
      broker.execute(
        request(
          token,
          'messages.trash',
          'gmail',
          'personal@example.com',
          'gmail-1',
          'kill-switch-001',
        ),
      ),
    /kill switch/,
  );
  assert.equal(adapter.calls, 0);
  assert.equal(adapter.snapshot()[0]?.location, 'inbox');
});
