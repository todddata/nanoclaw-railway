import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMailReportTask,
  findExistingMailReportTask,
  mailPilotConfig,
  mailPilotSystemPrompt,
} from '../dist/mail-pilot.js';
import { isHardenedMailCleanupScript } from '../dist/mail-cleanup-script.js';

const config = {
  provider: 'microsoft',
  mailboxId: 'pilot@example.com',
};

test('mail pilot requires an explicit enabled flag and safe exact config', () => {
  assert.equal(mailPilotConfig({}), null);
  assert.equal(
    mailPilotConfig({
      NANOCLAW_MAIL_PILOT_ENABLED: '1',
      NANOCLAW_MAIL_PILOT_PROVIDER: 'microsoft',
      NANOCLAW_MAIL_PILOT_MAILBOX_ID: '../../secrets',
    }),
    null,
  );
  assert.deepEqual(
    mailPilotConfig({
      NANOCLAW_MAIL_PILOT_ENABLED: '1',
      NANOCLAW_MAIL_PILOT_PROVIDER: 'microsoft',
      NANOCLAW_MAIL_PILOT_MAILBOX_ID: 'pilot@example.com',
    }),
    config,
  );
});

test('run-now task is due, isolated, and exact report-only JSON', () => {
  const now = new Date(2026, 7, 26, 12, 30, 0);
  const task = buildMailReportTask({
    config,
    chatJid: 'slack:C123',
    groupFolder: 'main',
    now,
  });
  assert.equal(task.schedule_type, 'once');
  assert.equal(task.schedule_value, '2026-08-26T12:29:59');
  assert.equal(task.context_mode, 'isolated');
  assert.equal(task.targetJid, 'slack:C123');
  assert.equal(isHardenedMailCleanupScript(task.script), true);
  const script = JSON.parse(task.script);
  assert.equal(script.action, 'report');
  assert.equal(script.mailboxId, 'pilot@example.com');
  assert.equal(Object.hasOwn(script, 'messageIds'), false);
});

test('recurring task preserves cron and cannot request mailbox mutations', () => {
  const task = buildMailReportTask({
    config,
    chatJid: 'slack:C123',
    groupFolder: 'main',
    now: new Date(2026, 7, 26, 12, 30, 0),
    cron: '0 2 * * *',
  });
  assert.equal(task.schedule_type, 'cron');
  assert.equal(task.schedule_value, '0 2 * * *');
  assert.equal(JSON.parse(task.script).action, 'report');
});

test('recurring report scheduling detects an identical active task', () => {
  const task = buildMailReportTask({
    config,
    chatJid: 'slack:C123',
    groupFolder: 'main',
    now: new Date(2026, 7, 26, 12, 30, 0),
    cron: '0 2 * * *',
  });
  assert.deepEqual(
    findExistingMailReportTask(
      [{ ...task, id: task.taskId, status: 'active' }],
      config,
      '0 2 * * *',
    ),
    { id: task.taskId },
  );
  assert.equal(
    findExistingMailReportTask(
      [{ ...task, status: 'paused' }],
      config,
      '0 2 * * *',
    ),
    null,
  );
});

test('system prompt names the broker and forbids credential workarounds', () => {
  const prompt = mailPilotSystemPrompt(config);
  assert.match(prompt, /MailBroker connection is configured/);
  assert.match(prompt, /never request credentials/i);
  assert.match(prompt, /untrusted data/i);
  assert.match(prompt, /run_mail_report/);
});
