import { createHmac, randomUUID } from 'node:crypto';

import { ScheduledTaskProvenance } from './task-provenance.js';

export type MailGrantOperation =
  | 'messages.list'
  | 'messages.get'
  | 'messages.modify_labels'
  | 'messages.trash'
  | 'messages.untrash'
  | 'messages.move_deleted'
  | 'messages.restore';

export interface HostMailGrantScope {
  provider: 'gmail' | 'microsoft';
  mailboxId: string;
  messageIds: string[];
  operations: MailGrantOperation[];
  maxActions: number;
}

export function createSignedMailGrantRequest(
  provenance: ScheduledTaskProvenance,
  taskId: string,
  scope: HostMailGrantScope,
  taskProvenanceSecret: string,
  now = new Date(),
) {
  if (taskProvenanceSecret.length < 32) {
    throw new Error('Task provenance secret is missing');
  }
  if (
    provenance.source.channel !== 'slack' ||
    provenance.allowedOperation !== 'scheduled_task.execute' ||
    provenance.source.channelId === '' ||
    provenance.source.userId === '' ||
    provenance.source.messageId === '' ||
    taskId === ''
  ) {
    throw new Error('Mail grant requires verified Slack task provenance');
  }
  const request = {
    version: 1 as const,
    requestId: `mail-run:${randomUUID()}`,
    source: {
      channel: 'slack' as const,
      workspaceId: provenance.source.workspaceId,
      channelId: provenance.source.channelId,
      userId: provenance.source.userId,
      taskId,
      messageId: provenance.source.messageId,
    },
    provider: scope.provider,
    mailboxId: scope.mailboxId,
    messageIds: [...scope.messageIds],
    operations: [...scope.operations],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    maxActions: scope.maxActions,
  };
  return {
    request,
    signature: createHmac('sha256', taskProvenanceSecret)
      .update(JSON.stringify(request))
      .digest('base64url'),
  };
}

export async function exchangeMailGrant(
  brokerUrl: string,
  signedRequest: ReturnType<typeof createSignedMailGrantRequest>,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ capability: string; grantId: string; expiresAt: string }> {
  const url = new URL('/v1/grants/exchange', brokerUrl);
  if (url.protocol !== 'http:' || !url.hostname.endsWith('.railway.internal')) {
    throw new Error('Mail broker URL must use Railway private networking');
  }
  const response = await fetchImplementation(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signedRequest),
  });
  if (response.status !== 201) {
    throw new Error(
      `Mail grant exchange rejected with status ${response.status}`,
    );
  }
  const result = (await response.json()) as Record<string, unknown>;
  if (
    typeof result.capability !== 'string' ||
    typeof result.grantId !== 'string' ||
    typeof result.expiresAt !== 'string'
  ) {
    throw new Error('Mail grant exchange returned an invalid response');
  }
  return result as {
    capability: string;
    grantId: string;
    expiresAt: string;
  };
}
