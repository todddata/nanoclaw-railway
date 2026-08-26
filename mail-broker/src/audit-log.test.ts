import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AppendOnlyAuditLog } from './audit-log.js';

test('writes a hash-chained append-only audit journal and verified digest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mail-audit-'));
  const path = join(directory, 'audit.jsonl');
  try {
    const log = new AppendOnlyAuditLog(path);
    const first = log.append({
      event: 'mail_action_authorized',
      outcome: 'authorized',
      mailboxId: 'personal@example.com',
      messageRefs: ['message-1'],
      operation: 'messages.trash',
      reasonCode: 'provider_spam',
      policyVersion: 'policy-1',
      modelVersion: 'none',
      grantId: 'grant-1',
      taskId: 'task-1',
      affected: 1,
    });
    const second = log.append({
      event: 'mail_action_rejected',
      outcome: 'rejected',
      reasonCode: 'request_rejected',
      policyVersion: 'policy-1',
      modelVersion: 'none',
    });
    assert.equal(second.previousHash, first.hash);
    assert.deepEqual(log.digest().counts, {
      'authorized:messages.trash': 1,
      'rejected:mail_action_rejected': 1,
    });
    assert.equal(log.digest().verified, true);
    assert.equal(
      readFileSync(path, { encoding: 'utf8' }).includes('token'),
      false,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fails closed when an audit entry is modified or appended out of chain', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mail-audit-tamper-'));
  const path = join(directory, 'audit.jsonl');
  try {
    const log = new AppendOnlyAuditLog(path);
    log.append({
      event: 'mail_security_alert',
      outcome: 'alert',
      reasonCode: 'repeated_denials',
    });
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('repeated_denials', 'hidden'),
    );
    assert.throws(() => new AppendOnlyAuditLog(path), /verification failed/);

    writeFileSync(path, '');
    appendFileSync(path, '{"version":1}\n');
    assert.throws(() => new AppendOnlyAuditLog(path), /verification failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
