import assert from 'node:assert/strict';
import test from 'node:test';

import { decideSpamAction, SpamDecisionInput } from './spam-policy.js';

const base: SpamDecisionInput = {
  record: {
    trust: 'untrusted-email-data',
    provider: 'gmail',
    mailboxId: 'mailbox@example.com',
    messageId: 'm1',
    from: 'sender@example.com',
    subject: '',
    text: '',
    attachmentNames: [],
    attachmentsQuarantined: false,
    quarantinedContent: [],
    limitsApplied: true,
    providerSpam: false,
  },
  classification: 'uncertain',
  confidence: 0.5,
  senderAllowlisted: false,
  senderBlocklisted: false,
  sensitive: false,
};

test('protects allowlisted and sensitive mail', () => {
  assert.equal(
    decideSpamAction({ ...base, senderAllowlisted: true }).action,
    'review',
  );
});

test('trashes provider spam but quarantines model-only high confidence spam', () => {
  assert.equal(
    decideSpamAction({
      ...base,
      record: { ...base.record, providerSpam: true },
    }).action,
    'trash',
  );
  assert.deepEqual(
    decideSpamAction({
      ...base,
      classification: 'high_confidence_spam',
      confidence: 0.99,
    }),
    {
      action: 'quarantine',
      reasonCode: 'high_confidence_spam',
      quarantineDays: 7,
    },
  );
});

test('routes uncertain mail to review', () => {
  assert.equal(decideSpamAction(base).action, 'review');
});
