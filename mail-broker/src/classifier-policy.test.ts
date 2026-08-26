import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canPromoteSpamThreshold,
  enforceSpamPolicy,
  MailboxSpamPolicy,
  parseClassifierOutput,
} from './classifier-policy.js';
import { InertEmailRecord } from './types.js';

const record: InertEmailRecord = {
  trust: 'untrusted-email-data',
  provider: 'gmail',
  mailboxId: 'personal@example.com',
  messageId: 'message-1',
  from: 'bulk@example.com',
  subject: 'Weekly promotion',
  text: 'A normal marketing message.',
  attachmentNames: [],
  attachmentsQuarantined: false,
  quarantinedContent: [],
  limitsApplied: true,
  providerSpam: false,
};
const policy: MailboxSpamPolicy = {
  mailboxId: 'personal@example.com',
  policyVersion: 'policy-v1',
  allowedModelVersions: ['classifier-v1'],
  allowlistedSenders: ['friend@example.com'],
  blocklistedSenders: ['blocked@example.com'],
  minimumQuarantineConfidence: 0.98,
  maxActionsPerRun: 20,
};
const highConfidence = {
  classification: 'high_confidence_spam',
  confidence: 0.99,
  modelVersion: 'classifier-v1',
};

test('accepts only the strict tool-free classifier schema', () => {
  assert.deepEqual(parseClassifierOutput(highConfidence), highConfidence);
  for (const unsafe of [
    { ...highConfidence, tool: 'messages.trash' },
    { ...highConfidence, classification: 'messages.send' },
    { ...highConfidence, confidence: 2 },
    { ...highConfidence, modelVersion: '../unapproved' },
    'trash it',
  ]) {
    assert.throws(() => parseClassifierOutput(unsafe), /strict schema|object/);
  }
});

test('quarantines only approved high-confidence model spam', () => {
  assert.deepEqual(enforceSpamPolicy(record, highConfidence, policy, 0), {
    action: 'quarantine',
    reasonCode: 'high_confidence_spam',
    quarantineDays: 7,
    policyVersion: 'policy-v1',
    modelVersion: 'classifier-v1',
  });
  assert.equal(
    enforceSpamPolicy(
      record,
      { ...highConfidence, confidence: 0.979 },
      policy,
      0,
    ).action,
    'review',
  );
});

test('protects sensitive and allowlisted mail outside the model', () => {
  for (const protectedRecord of [
    { ...record, from: 'friend@example.com' },
    { ...record, subject: 'Security alert for your account' },
    { ...record, text: 'Your medical prescription is ready.' },
    { ...record, subject: 'Employment interview' },
  ]) {
    assert.equal(
      enforceSpamPolicy(protectedRecord, highConfidence, policy, 0).action,
      'review',
    );
  }
});

test('allows only provider spam or explicit blocklist to use recoverable trash', () => {
  assert.equal(
    enforceSpamPolicy({ ...record, providerSpam: true }, highConfidence, policy, 0)
      .action,
    'trash',
  );
  assert.equal(
    enforceSpamPolicy(
      { ...record, from: 'blocked@example.com' },
      highConfidence,
      policy,
      0,
    ).action,
    'trash',
  );
});

test('enforces mailbox, version, and run quota outside the model', () => {
  assert.throws(
    () => enforceSpamPolicy({ ...record, mailboxId: 'other@example.com' }, highConfidence, policy, 0),
    /no matching/,
  );
  assert.throws(
    () =>
      enforceSpamPolicy(
        record,
        { ...highConfidence, modelVersion: 'classifier-unknown' },
        policy,
        0,
      ),
    /not approved/,
  );
  assert.equal(
    enforceSpamPolicy(record, highConfidence, policy, 20).reasonCode,
    'mailbox_action_quota_reached',
  );
});

test('requires a measured false-positive sample before threshold promotion', () => {
  assert.equal(
    canPromoteSpamThreshold({ reviewedMessages: 999, falsePositives: 0 }),
    false,
  );
  assert.equal(
    canPromoteSpamThreshold({ reviewedMessages: 1000, falsePositives: 1 }),
    true,
  );
  assert.equal(
    canPromoteSpamThreshold({ reviewedMessages: 1000, falsePositives: 2 }),
    false,
  );
});
