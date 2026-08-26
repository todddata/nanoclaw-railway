import { InertEmailRecord, UntrustedEmailInput } from './types.js';

const MAX_FIELD = 8_000;
const MAX_TEXT = 50_000;
const MAX_ATTACHMENTS = 50;

function clean(value: string | undefined, maximum: number): string {
  return (value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/https?:\/\/\S+/gi, '[external-link-removed]')
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
  if (!input.mailboxId || !input.messageId) {
    throw new Error('Mailbox and message IDs are required');
  }

  const attachmentNames = (input.attachmentNames || [])
    .slice(0, MAX_ATTACHMENTS)
    .map((name) => clean(name, 256));
  const plain = clean(input.text, MAX_TEXT);
  const html = htmlToInertText(input.html);

  return {
    trust: 'untrusted-email-data',
    provider: input.provider,
    mailboxId: clean(input.mailboxId, MAX_FIELD),
    messageId: clean(input.messageId, MAX_FIELD),
    threadId: input.threadId ? clean(input.threadId, MAX_FIELD) : undefined,
    from: clean(input.from, MAX_FIELD),
    subject: clean(input.subject, MAX_FIELD),
    text: plain || html,
    attachmentNames,
    attachmentsQuarantined: attachmentNames.length > 0,
    providerSpam: input.providerSpam === true,
  };
}
