export const ALLOWED_OPERATIONS = [
  'messages.list',
  'messages.get',
  'messages.modify_labels',
  'messages.trash',
  'messages.untrash',
  'messages.move_deleted',
  'messages.restore',
] as const;

export type AllowedOperation = (typeof ALLOWED_OPERATIONS)[number];
export type MailProvider = 'gmail' | 'microsoft';

export interface SlackGrantSource {
  channel: 'slack';
  workspaceId: string;
  channelId: string;
  userId: string;
  taskId: string;
}

export interface CapabilityPayload {
  version: 1;
  grantId: string;
  source: SlackGrantSource;
  mailboxIds: string[];
  operations: AllowedOperation[];
  issuedAt: string;
  expiresAt: string;
  maxActions: number;
}

export interface BrokerActionRequest {
  capability: string;
  operation: AllowedOperation;
  provider: MailProvider;
  mailboxId: string;
  messageIds?: string[];
  addLabels?: string[];
  removeLabels?: string[];
  reasonCode: string;
  idempotencyKey: string;
}

export interface BrokerActionResult {
  ok: true;
  mode: 'mock';
  operation: AllowedOperation;
  affected: number;
  grantId: string;
  messages?: MockMessageView[];
}

export interface MockMessageView {
  provider: MailProvider;
  mailboxId: string;
  messageId: string;
  labels: string[];
  location: 'inbox' | 'trash' | 'deleted';
}

export interface UntrustedEmailInput {
  provider: MailProvider;
  mailboxId: string;
  messageId: string;
  threadId?: string;
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  quotedText?: string;
  headers?: Record<string, string>;
  attachmentNames?: string[];
  attachmentContentTypes?: string[];
  calendarPayload?: string;
  embeddedMessageCount?: number;
  ingestion?: {
    rawBytes: number;
    mimeParts: number;
    maxDepth: number;
    expandedBytes: number;
    encodingErrors: number;
  };
  providerSpam?: boolean;
}

export interface InertEmailRecord {
  trust: 'untrusted-email-data';
  provider: MailProvider;
  mailboxId: string;
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  text: string;
  attachmentNames: string[];
  attachmentsQuarantined: boolean;
  quarantinedContent: Array<
    'attachments' | 'calendar' | 'embedded_messages' | 'encrypted_archive'
  >;
  limitsApplied: true;
  providerSpam: boolean;
}
