import { createHmac, timingSafeEqual } from 'node:crypto';

import { ScheduledTask } from './types.js';

export interface ActiveCommandGrant {
  version: 1;
  channel: 'slack';
  workspaceId: string;
  channelId: string;
  userId: string;
  messageId: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ScheduledTaskProvenance {
  version: 1;
  source: Omit<ActiveCommandGrant, 'expiresAt'>;
  allowedOperation: 'scheduled_task.execute';
  issuedAt: string;
  expiresAt: string;
}

type SignableTask = Pick<
  ScheduledTask,
  | 'id'
  | 'group_folder'
  | 'chat_jid'
  | 'prompt'
  | 'script'
  | 'schedule_type'
  | 'schedule_value'
  | 'context_mode'
>;

function taskPayload(
  task: SignableTask,
  provenance: ScheduledTaskProvenance,
): string {
  return JSON.stringify({
    version: 1,
    task: {
      id: task.id,
      group_folder: task.group_folder,
      chat_jid: task.chat_jid,
      prompt: task.prompt,
      script: task.script || null,
      schedule_type: task.schedule_type,
      schedule_value: task.schedule_value,
      context_mode: task.context_mode,
    },
    provenance,
  });
}

function signature(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

function assertSecret(secret: string): void {
  if (secret.length < 32) throw new Error('Task provenance secret is missing');
}

export function createActiveCommandGrant(
  input: {
    workspaceId: string;
    chatJid: string;
    userId: string;
    messageId: string;
  },
  now = new Date(),
): ActiveCommandGrant {
  if (
    !input.workspaceId ||
    !input.chatJid.startsWith('slack:') ||
    !input.userId ||
    !input.messageId
  ) {
    throw new Error('Incomplete Slack command provenance');
  }
  return {
    version: 1,
    channel: 'slack',
    workspaceId: input.workspaceId,
    channelId: input.chatJid.slice('slack:'.length),
    userId: input.userId,
    messageId: input.messageId,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
  };
}

export function isActiveCommandGrant(
  grant: ActiveCommandGrant | undefined,
  now = new Date(),
): grant is ActiveCommandGrant {
  return !!(
    grant &&
    grant.version === 1 &&
    grant.channel === 'slack' &&
    grant.workspaceId &&
    grant.channelId &&
    grant.userId &&
    grant.messageId &&
    Date.parse(grant.issuedAt) <= now.getTime() + 60_000 &&
    Date.parse(grant.expiresAt) > now.getTime()
  );
}

export function signScheduledTask(
  task: SignableTask,
  grant: ActiveCommandGrant,
  secret: string,
  now = new Date(),
): { provenance_json: string; provenance_signature: string } {
  assertSecret(secret);
  if (!isActiveCommandGrant(grant, now)) {
    throw new Error('No active Slack command grant');
  }
  const provenance: ScheduledTaskProvenance = {
    version: 1,
    source: {
      version: grant.version,
      channel: grant.channel,
      workspaceId: grant.workspaceId,
      channelId: grant.channelId,
      userId: grant.userId,
      messageId: grant.messageId,
      issuedAt: grant.issuedAt,
    },
    allowedOperation: 'scheduled_task.execute',
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
  const provenance_json = JSON.stringify(provenance);
  return {
    provenance_json,
    provenance_signature: signature(
      taskPayload(task, provenance),
      secret,
    ).toString('base64url'),
  };
}

export function verifyScheduledTask(
  task: SignableTask & {
    provenance_json?: string | null;
    provenance_signature?: string | null;
  },
  secret: string,
  now = new Date(),
): ScheduledTaskProvenance {
  assertSecret(secret);
  if (!task.provenance_json || !task.provenance_signature) {
    throw new Error('Scheduled task has no signed provenance');
  }
  const provenance = JSON.parse(
    task.provenance_json,
  ) as ScheduledTaskProvenance;
  if (
    provenance.version !== 1 ||
    provenance.source?.channel !== 'slack' ||
    provenance.allowedOperation !== 'scheduled_task.execute' ||
    !provenance.source.workspaceId ||
    !provenance.source.channelId ||
    !provenance.source.userId ||
    Date.parse(provenance.issuedAt) > now.getTime() + 60_000 ||
    Date.parse(provenance.expiresAt) <= now.getTime()
  ) {
    throw new Error('Scheduled task provenance is invalid or expired');
  }

  const expected = signature(taskPayload(task, provenance), secret);
  const supplied = Buffer.from(task.provenance_signature, 'base64url');
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    throw new Error('Scheduled task provenance signature is invalid');
  }
  return provenance;
}
