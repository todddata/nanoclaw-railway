import { randomUUID } from 'node:crypto';

import {
  createSignedMailGrantRequest,
  exchangeMailGrant,
  executeMailAction,
  InertMailRecord,
  MailBrokerActionRequest,
  MailGrantOperation,
} from './mail-grant.js';
import { ScheduledTaskProvenance } from './task-provenance.js';

export interface MailCleanupConfig {
  version: 1;
  type: 'mail_spam_cleanup';
  provider: 'gmail' | 'microsoft';
  mailboxId: string;
  action: 'report' | 'recoverable_trash_provider_spam';
  maxMessages: number;
  maxActions: number;
}

export interface MailCleanupResult {
  scanned: number;
  providerSpamFound: number;
  movedToRecoverableTrash: number;
  summary: string;
}

const SAFE_MAILBOX = /^[a-zA-Z0-9@._+\-=]{1,320}$/;
const SAFE_MESSAGE_ID = /^[a-zA-Z0-9@._:+\-=]{1,512}$/;

export function parseMailCleanupScript(
  script: string | null | undefined,
): MailCleanupConfig | null {
  if (!script?.trim().startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(script);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).type !== 'mail_spam_cleanup'
  ) {
    return null;
  }
  const input = parsed as Record<string, unknown>;
  const allowedKeys = [
    'version',
    'type',
    'provider',
    'mailboxId',
    'action',
    'maxMessages',
    'maxActions',
  ];
  if (
    Object.keys(input).length !== allowedKeys.length ||
    Object.keys(input).some((key) => !allowedKeys.includes(key)) ||
    input.version !== 1 ||
    (input.provider !== 'gmail' && input.provider !== 'microsoft') ||
    typeof input.mailboxId !== 'string' ||
    !SAFE_MAILBOX.test(input.mailboxId) ||
    (input.action !== 'report' &&
      input.action !== 'recoverable_trash_provider_spam') ||
    !Number.isSafeInteger(input.maxMessages) ||
    (input.maxMessages as number) < 1 ||
    (input.maxMessages as number) > 100 ||
    !Number.isSafeInteger(input.maxActions) ||
    (input.maxActions as number) < 1 ||
    (input.maxActions as number) > 50 ||
    (input.maxActions as number) > (input.maxMessages as number)
  ) {
    throw new Error('Mail cleanup script is invalid');
  }
  return input as unknown as MailCleanupConfig;
}

export interface MailCleanupRunOptions {
  config: MailCleanupConfig;
  enabled: boolean;
  brokerUrl: string;
  provenance: ScheduledTaskProvenance;
  taskId: string;
  taskProvenanceSecret: string;
  now?: () => Date;
  createRunId?: () => string;
  exchange?: typeof exchangeMailGrant;
  execute?: typeof executeMailAction;
}

function validateRecords(
  value: InertMailRecord[] | undefined,
  config: MailCleanupConfig,
): InertMailRecord[] {
  if (!value) return [];
  const seen = new Set<string>();
  const records: InertMailRecord[] = [];
  for (const record of value.slice(0, config.maxMessages)) {
    if (
      !record ||
      record.trust !== 'untrusted-email-data' ||
      record.provider !== config.provider ||
      record.mailboxId.toLowerCase() !== config.mailboxId.toLowerCase() ||
      typeof record.messageId !== 'string' ||
      !SAFE_MESSAGE_ID.test(record.messageId) ||
      typeof record.providerSpam !== 'boolean'
    ) {
      throw new Error('Mail broker returned an out-of-scope record');
    }
    if (!seen.has(record.messageId)) {
      seen.add(record.messageId);
      records.push(record);
    }
  }
  return records;
}

export async function runMailCleanup(
  options: MailCleanupRunOptions,
): Promise<MailCleanupResult> {
  if (!options.enabled) throw new Error('Mail cleanup is disabled');
  if (!options.brokerUrl) throw new Error('Mail broker URL is missing');
  const now = options.now?.() || new Date();
  const runId = options.createRunId?.() || randomUUID();
  const exchange = options.exchange || exchangeMailGrant;
  const execute = options.execute || executeMailAction;

  const listGrant = await exchange(
    options.brokerUrl,
    createSignedMailGrantRequest(
      options.provenance,
      options.taskId,
      {
        provider: options.config.provider,
        mailboxId: options.config.mailboxId,
        messageIds: [`scan:${runId}`],
        operations: ['messages.list'],
        maxActions: 1,
      },
      options.taskProvenanceSecret,
      now,
    ),
  );
  const listResult = await execute(options.brokerUrl, {
    capability: listGrant.capability,
    operation: 'messages.list',
    provider: options.config.provider,
    mailboxId: options.config.mailboxId,
    reasonCode: 'scheduled.provider_spam_scan',
    idempotencyKey: `scan:${runId}`,
  });
  const records = validateRecords(listResult.records, options.config);
  const providerSpam = records
    .filter((record) => record.providerSpam)
    .slice(0, options.config.maxActions);

  if (options.config.action === 'report' || providerSpam.length === 0) {
    return {
      scanned: records.length,
      providerSpamFound: providerSpam.length,
      movedToRecoverableTrash: 0,
      summary: `Mail scan complete: ${records.length} checked, ${providerSpam.length} provider-flagged spam message(s), no mailbox changes.`,
    };
  }

  const operation: MailGrantOperation =
    options.config.provider === 'gmail'
      ? 'messages.trash'
      : 'messages.move_deleted';
  const actionGrant = await exchange(
    options.brokerUrl,
    createSignedMailGrantRequest(
      options.provenance,
      options.taskId,
      {
        provider: options.config.provider,
        mailboxId: options.config.mailboxId,
        messageIds: providerSpam.map((record) => record.messageId),
        operations: [operation],
        maxActions: providerSpam.length,
      },
      options.taskProvenanceSecret,
      now,
    ),
  );
  const action: MailBrokerActionRequest = {
    capability: actionGrant.capability,
    operation,
    provider: options.config.provider,
    mailboxId: options.config.mailboxId,
    messageIds: providerSpam.map((record) => record.messageId),
    reasonCode: 'scheduled.provider_spam_recoverable_trash',
    idempotencyKey: `trash:${runId}`,
  };
  const actionResult = await execute(options.brokerUrl, action);
  if (actionResult.affected !== providerSpam.length) {
    throw new Error(
      'Mail broker affected count did not match exact grant scope',
    );
  }
  return {
    scanned: records.length,
    providerSpamFound: providerSpam.length,
    movedToRecoverableTrash: actionResult.affected,
    summary: `Mail cleanup complete: ${records.length} checked, ${actionResult.affected} provider-flagged spam message(s) moved to recoverable trash.`,
  };
}
