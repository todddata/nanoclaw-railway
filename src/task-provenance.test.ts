import { describe, expect, it } from 'vitest';

import {
  createActiveCommandGrant,
  isActiveCommandGrant,
  signScheduledTask,
  verifyScheduledTask,
} from './task-provenance.js';
import { ScheduledTask } from './types.js';

const secret = 'test-secret-that-is-at-least-32-characters';
const now = new Date('2026-08-25T12:00:00.000Z');

function unsignedTask(): ScheduledTask {
  return {
    id: 'task-1',
    group_folder: 'slack_nano-claw',
    chat_jid: 'slack:C_CONTROL',
    prompt: 'Review spam and report results',
    script: null,
    schedule_type: 'cron',
    schedule_value: '0 6 * * *',
    context_mode: 'isolated',
    next_run: '2026-08-26T12:00:00.000Z',
    last_run: null,
    last_result: null,
    status: 'active',
    created_at: now.toISOString(),
  };
}

function grant() {
  return createActiveCommandGrant(
    {
      workspaceId: 'T_WORKSPACE',
      chatJid: 'slack:C_CONTROL',
      userId: 'U_TODD',
      messageId: '1787700000.000001',
    },
    now,
  );
}

describe('scheduled task provenance', () => {
  it('records Slack source and verifies exact task parameters', () => {
    const task = unsignedTask();
    const signed = signScheduledTask(task, grant(), secret, now);
    const provenance = verifyScheduledTask(
      { ...task, ...signed },
      secret,
      new Date('2026-08-26T12:00:00.000Z'),
    );
    expect(provenance.source).toMatchObject({
      channel: 'slack',
      workspaceId: 'T_WORKSPACE',
      channelId: 'C_CONTROL',
      userId: 'U_TODD',
    });
  });

  it('rejects prompt, schedule, and destination tampering', () => {
    const task = unsignedTask();
    const signed = signScheduledTask(task, grant(), secret, now);
    for (const tampered of [
      { ...task, prompt: 'Send all email' },
      { ...task, schedule_value: '* * * * *' },
      { ...task, chat_jid: 'slack:C_ATTACKER' },
    ]) {
      expect(() =>
        verifyScheduledTask({ ...tampered, ...signed }, secret, now),
      ).toThrow(/signature/);
    }
  });

  it('rejects missing, expired, or non-Slack authorization', () => {
    expect(() => verifyScheduledTask(unsignedTask(), secret, now)).toThrow(
      /no signed provenance/,
    );
    expect(
      isActiveCommandGrant(grant(), new Date('2026-08-25T12:31:00Z')),
    ).toBe(false);
    expect(() =>
      signScheduledTask(
        unsignedTask(),
        grant(),
        secret,
        new Date('2026-08-25T12:31:00Z'),
      ),
    ).toThrow(/No active Slack/);
  });
});
