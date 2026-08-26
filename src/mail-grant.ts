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

export interface MailBrokerActionRequest {
  capability: string;
  operation: MailGrantOperation;
  provider: 'gmail' | 'microsoft';
  mailboxId: string;
  messageIds?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  reasonCode: string;
  idempotencyKey: string;
}

export interface InertMailRecord {
  trust: 'untrusted-email-data';
  provider: 'gmail' | 'microsoft';
  mailboxId: string;
  messageId: string;
  providerSpam: boolean;
}

export interface MailBrokerActionResult {
  ok: true;
  operation: MailGrantOperation;
  affected: number;
  grantId: string;
  records?: InertMailRecord[];
}

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
  const url = privateBrokerUrl(brokerUrl, '/v1/grants/exchange');
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

function privateBrokerUrl(brokerUrl: string, path: string): URL {
  const url = new URL(path, brokerUrl);
  if (
    url.protocol !== 'http:' ||
    !url.hostname.toLowerCase().endsWith('.railway.internal')
  ) {
    throw new Error('Mail broker URL must use Railway private networking');
  }
  return url;
}

export async function executeMailAction(
  brokerUrl: string,
  action: MailBrokerActionRequest,
  fetchImplementation: typeof fetch = fetch,
): Promise<MailBrokerActionResult> {
  const response = await fetchImplementation(
    privateBrokerUrl(brokerUrl, '/v1/actions'),
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    },
  );
  if (response.status !== 200) {
    throw new Error(`Mail action rejected with status ${response.status}`);
  }
  const result = (await response.json()) as Record<string, unknown>;
  if (
    result.ok !== true ||
    typeof result.operation !== 'string' ||
    typeof result.affected !== 'number' ||
    !Number.isSafeInteger(result.affected) ||
    result.affected < 0 ||
    typeof result.grantId !== 'string' ||
    (result.records !== undefined && !Array.isArray(result.records))
  ) {
    throw new Error('Mail action returned an invalid response');
  }
  return result as unknown as MailBrokerActionResult;
}
