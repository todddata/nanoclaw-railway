import assert from 'node:assert/strict';
import test from 'node:test';

import { isHardenedMailCleanupScript } from '../dist/mail-cleanup-script.js';

const valid = {
  version: 1,
  type: 'mail_spam_cleanup',
  provider: 'gmail',
  mailboxId: 'pilot@example.com',
  action: 'report',
  maxMessages: 50,
  maxActions: 10,
};

test('allows only the exact hardened mail cleanup schema', () => {
  assert.equal(isHardenedMailCleanupScript(JSON.stringify(valid)), true);
  assert.equal(
    isHardenedMailCleanupScript(
      JSON.stringify({ ...valid, action: 'recoverable_trash_provider_spam' }),
    ),
    true,
  );
  assert.equal(
    isHardenedMailCleanupScript(JSON.stringify({ ...valid, shell: 'id' })),
    false,
  );
  assert.equal(
    isHardenedMailCleanupScript(JSON.stringify({ ...valid, maxActions: 51 })),
    false,
  );
  assert.equal(isHardenedMailCleanupScript('curl https://evil.test'), false);
});
