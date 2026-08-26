import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import { MailCleanupConfig } from './mail-cleanup.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';
import {
  createActiveCommandGrant,
  signScheduledTask,
} from './task-provenance.js';

const taskSecret = 'task-provenance-secret-at-least-32-chars';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('routes a signed mail cleanup task through the host workflow without launching an agent', async () => {
    const now = new Date();
    const cleanupConfig: MailCleanupConfig = {
      version: 1,
      type: 'mail_spam_cleanup',
      provider: 'gmail',
      mailboxId: 'pilot@example.com',
      action: 'report',
      maxMessages: 20,
      maxActions: 5,
    };
    const task = {
      id: 'task-mail-cleanup',
      group_folder: 'main',
      chat_jid: 'slack:C_CONTROL',
      prompt: 'Run the hardened provider-spam report.',
      script: JSON.stringify(cleanupConfig),
      schedule_type: 'once' as const,
      schedule_value: new Date(now.getTime() - 1_000).toISOString(),
      context_mode: 'isolated' as const,
      next_run: new Date(now.getTime() - 1_000).toISOString(),
      status: 'active' as const,
      created_at: now.toISOString(),
    };
    const grant = createActiveCommandGrant(
      {
        workspaceId: 'T123',
        chatJid: 'slack:C_CONTROL',
        userId: 'U_OWNER',
        messageId: 'slack-message-1',
      },
      now,
    );
    createTask({
      ...task,
      ...signScheduledTask(task, grant, taskSecret, now),
    });
    const completed = new Promise<void>((resolve) => {
      const runMailCleanup = vi.fn(async () => {
        resolve();
        return {
          scanned: 12,
          providerSpamFound: 2,
          movedToRecoverableTrash: 0,
          summary:
            'Mail scan complete: 12 checked, 2 provider-flagged spam message(s), no mailbox changes.',
          reviewItems: [],
        };
      });
      const sendMessage = vi.fn(async () => {});
      startSchedulerLoop({
        registeredGroups: () => ({
          'slack:C_CONTROL': {
            name: 'NanoClaw',
            folder: 'main',
            trigger: '@NanoClaw',
            added_at: now.toISOString(),
            isMain: true,
          },
        }),
        getSessions: () => ({}),
        queue: {
          enqueueTask: (
            _jid: string,
            _taskId: string,
            fn: () => Promise<void>,
          ) => void fn(),
        } as any,
        onProcess: vi.fn(),
        sendMessage,
        taskProvenanceSecret: taskSecret,
        mailCleanupEnabled: true,
        mailBrokerUrl: 'http://mailbroker.railway.internal:8080',
        runMailCleanup,
      });
    });
    await vi.advanceTimersByTimeAsync(10);
    await completed;
    expect(getTaskById('task-mail-cleanup')?.status).toBe('completed');
  });
});
