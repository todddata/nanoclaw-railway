import { InertEmailRecord, UntrustedEmailInput } from './types.js';

const MAX_ID = 512;
const MAX_FIELD = 8_000;
const MAX_TEXT = 50_000;
const MAX_ATTACHMENTS = 50;
const MAX_HEADERS = 200;
const MAX_RAW_BYTES = 10 * 1024 * 1024;
const MAX_MIME_PARTS = 200;
const MAX_MIME_DEPTH = 12;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_ENCODING_ERRORS = 10;

const EXTERNAL_LINK = /(?:https?|ftp):\/\/[^\s<>"']+|www\.[^\s<>"']+/gi;
const ENCRYPTED_ARCHIVE = /(?:application\/(?:zip|x-7z-compressed|x-rar-compressed)|\.zip$|\.7z$|\.rar$)/i;

function clean(value: string | undefined, maximum: number): string {
  return (value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(EXTERNAL_LINK, '[external-link-removed]')
    .slice(0, maximum);
}

function htmlToInertText(html: string | undefined): string {
  return clean(
    (html || '')
      .replace(/<(script|style|svg|object|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<img\b[^>]*>/gi, ' [remote-image-removed] ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&')
      .replace(/\s+/g, ' '),
    MAX_TEXT,
  );
}

export function sanitizeEmail(input: UntrustedEmailInput): InertEmailRecord {
  if (
    (input.provider !== 'gmail' && input.provider !== 'microsoft') ||
    !input.mailboxId ||
    !input.messageId ||
    input.mailboxId.length > MAX_ID ||
    input.messageId.length > MAX_ID
  ) {
    throw new Error('Valid provider, mailbox ID, and message ID are required');
  }

  const attachmentNamesRaw = input.attachmentNames || [];
  const contentTypes = input.attachmentContentTypes || [];
  if (
    attachmentNamesRaw.length > MAX_ATTACHMENTS ||
    contentTypes.length > MAX_ATTACHMENTS ||
    Object.keys(input.headers || {}).length > MAX_HEADERS
  ) {
    throw new Error('Email structure exceeds ingestion limits');
  }

  const limits = input.ingestion;
  if (
    limits &&
    (!Number.isSafeInteger(limits.rawBytes) ||
      limits.rawBytes < 0 ||
      limits.rawBytes > MAX_RAW_BYTES ||
      !Number.isSafeInteger(limits.mimeParts) ||
      limits.mimeParts < 1 ||
      limits.mimeParts > MAX_MIME_PARTS ||
      !Number.isSafeInteger(limits.maxDepth) ||
      limits.maxDepth < 0 ||
      limits.maxDepth > MAX_MIME_DEPTH ||
      !Number.isSafeInteger(limits.expandedBytes) ||
      limits.expandedBytes < 0 ||
      limits.expandedBytes > MAX_EXPANDED_BYTES ||
      !Number.isSafeInteger(limits.encodingErrors) ||
      limits.encodingErrors < 0 ||
      limits.encodingErrors > MAX_ENCODING_ERRORS)
  ) {
    throw new Error('Email resource limits exceeded');
  }

  const attachmentNames = attachmentNamesRaw.map((name) => clean(name, 256));
  const plain = clean(input.text, MAX_TEXT);
  const html = htmlToInertText(input.html);
  const quoted = clean(input.quotedText, MAX_TEXT);
  const text = [plain || html, quoted ? `[untrusted-quoted-text]\n${quoted}` : '']
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_TEXT);
  const quarantinedContent = new Set<
    'attachments' | 'calendar' | 'embedded_messages' | 'encrypted_archive'
  >();
  if (attachmentNames.length || contentTypes.length) {
    quarantinedContent.add('attachments');
  }
  if (input.calendarPayload) quarantinedContent.add('calendar');
  if ((input.embeddedMessageCount || 0) > 0) {
    quarantinedContent.add('embedded_messages');
  }
  if (
    [...attachmentNames, ...contentTypes].some((value) =>
      ENCRYPTED_ARCHIVE.test(value),
    )
  ) {
    quarantinedContent.add('encrypted_archive');
  }

  return {
    trust: 'untrusted-email-data',
    provider: input.provider,
    mailboxId: clean(input.mailboxId, MAX_FIELD),
    messageId: clean(input.messageId, MAX_FIELD),
    threadId: input.threadId ? clean(input.threadId, MAX_FIELD) : undefined,
    from: clean(input.from, MAX_FIELD),
    subject: clean(input.subject, MAX_FIELD),
    text,
    attachmentNames,
    attachmentsQuarantined: quarantinedContent.has('attachments'),
    quarantinedContent: [...quarantinedContent],
    limitsApplied: true,
    providerSpam: input.providerSpam === true,
  };
}
