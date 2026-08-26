import { OAuthTokenSource } from './oauth.js';
import { sanitizeEmail } from './sanitize.js';
import {
  AdapterActionResult,
  BrokerActionRequest,
  InertEmailRecord,
  MailboxAdapter,
  MailProvider,
  UntrustedEmailInput,
} from './types.js';

interface ProviderAdapterConfig {
  mailboxId: string;
  tokenSource: OAuthTokenSource;
  fetch?: typeof globalThis.fetch;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function decodeBase64Url(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100_000) return '';
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

abstract class FixedProviderAdapter implements MailboxAdapter {
  protected readonly fetch: typeof globalThis.fetch;
  private identityVerified = false;

  protected constructor(
    readonly provider: MailProvider,
    protected readonly config: ProviderAdapterConfig,
  ) {
    if (!config.mailboxId)
      throw new Error('Provider mailbox is not configured');
    this.fetch = config.fetch || globalThis.fetch;
  }

  protected abstract verifyIdentity(token: string): Promise<void>;
  protected abstract perform(
    action: BrokerActionRequest,
    token: string,
  ): Promise<AdapterActionResult>;

  async execute(action: BrokerActionRequest): Promise<AdapterActionResult> {
    if (
      action.provider !== this.provider ||
      action.mailboxId.toLowerCase() !== this.config.mailboxId.toLowerCase()
    ) {
      throw new Error('Action is outside configured provider mailbox');
    }
    const token = await this.config.tokenSource.getAccessToken();
    if (!this.identityVerified) {
      await this.verifyIdentity(token);
      this.identityVerified = true;
    }
    return this.perform(action, token);
  }

  protected async json(
    url: string,
    token: string,
    init: RequestInit = {},
  ): Promise<JsonObject> {
    const response = await this.fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(init.headers || {}),
      },
      redirect: 'error',
    });
    if (!response.ok)
      throw new Error(`${this.provider} provider request failed`);
    if (response.status === 204) return {};
    return object(await response.json());
  }
}

interface GmailPartSummary {
  text: string[];
  html: string[];
  attachmentNames: string[];
  attachmentTypes: string[];
  parts: number;
  depth: number;
}

function gmailPartSummary(root: unknown): GmailPartSummary {
  const result: GmailPartSummary = {
    text: [],
    html: [],
    attachmentNames: [],
    attachmentTypes: [],
    parts: 0,
    depth: 0,
  };
  const visit = (raw: unknown, depth: number): void => {
    if (result.parts >= 200 || depth > 12) return;
    const part = object(raw);
    result.parts += 1;
    result.depth = Math.max(result.depth, depth);
    const mimeType = typeof part.mimeType === 'string' ? part.mimeType : '';
    const filename = typeof part.filename === 'string' ? part.filename : '';
    const body = object(part.body);
    if (filename) {
      result.attachmentNames.push(filename);
      result.attachmentTypes.push(mimeType);
      // Deliberately ignore attachmentId. Attachments are never downloaded.
    } else {
      const inline = decodeBase64Url(body.data);
      if (mimeType === 'text/plain' && inline) result.text.push(inline);
      if (mimeType === 'text/html' && inline) result.html.push(inline);
    }
    if (Array.isArray(part.parts)) {
      for (const child of part.parts) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return result;
}

function gmailRecord(raw: unknown, mailboxId: string): InertEmailRecord {
  const message = object(raw);
  const payload = object(message.payload);
  const headers: Record<string, string> = {};
  if (Array.isArray(payload.headers)) {
    for (const rawHeader of payload.headers.slice(0, 200)) {
      const header = object(rawHeader);
      if (typeof header.name === 'string' && typeof header.value === 'string') {
        headers[header.name.toLowerCase()] = header.value;
      }
    }
  }
  const parts = gmailPartSummary(payload);
  return sanitizeEmail({
    provider: 'gmail',
    mailboxId,
    messageId: String(message.id || ''),
    threadId:
      typeof message.threadId === 'string' ? message.threadId : undefined,
    from: headers.from,
    subject: headers.subject,
    text: parts.text.join('\n'),
    html: parts.html.join('\n'),
    headers,
    attachmentNames: parts.attachmentNames.slice(0, 50),
    attachmentContentTypes: parts.attachmentTypes.slice(0, 50),
    ingestion: {
      rawBytes:
        typeof message.sizeEstimate === 'number' ? message.sizeEstimate : 0,
      mimeParts: Math.max(1, parts.parts),
      maxDepth: parts.depth,
      expandedBytes: Buffer.byteLength(
        [...parts.text, ...parts.html].join('\n'),
      ),
      encodingErrors: 0,
    },
    providerSpam: strings(message.labelIds).includes('SPAM'),
  });
}

export class GmailAdapter extends FixedProviderAdapter {
  private static readonly base =
    'https://gmail.googleapis.com/gmail/v1/users/me';
  private labelIds: Map<string, string> | undefined;

  constructor(config: ProviderAdapterConfig) {
    super('gmail', config);
  }

  protected async verifyIdentity(token: string): Promise<void> {
    const profile = await this.json(`${GmailAdapter.base}/profile`, token);
    if (
      typeof profile.emailAddress !== 'string' ||
      profile.emailAddress.toLowerCase() !== this.config.mailboxId.toLowerCase()
    ) {
      throw new Error('Gmail identity does not match configured mailbox');
    }
  }

  private async getMessage(messageId: string, token: string) {
    const id = encodeURIComponent(messageId);
    return gmailRecord(
      await this.json(`${GmailAdapter.base}/messages/${id}?format=full`, token),
      this.config.mailboxId,
    );
  }

  private async resolveLabelIds(labels: string[], token: string) {
    if (!labels.length) return [];
    if (!this.labelIds) {
      const response = await this.json(`${GmailAdapter.base}/labels`, token);
      this.labelIds = new Map();
      if (Array.isArray(response.labels)) {
        for (const raw of response.labels) {
          const label = object(raw);
          if (typeof label.id === 'string') {
            this.labelIds.set(label.id, label.id);
            if (typeof label.name === 'string') {
              this.labelIds.set(label.name, label.id);
            }
          }
        }
      }
    }
    return labels.map((label) => {
      const id = this.labelIds?.get(label);
      if (!id) throw new Error('Gmail label is not available');
      return id;
    });
  }

  protected async perform(
    action: BrokerActionRequest,
    token: string,
  ): Promise<AdapterActionResult> {
    if (action.operation === 'messages.list') {
      const page = await this.json(
        `${GmailAdapter.base}/messages?maxResults=50&includeSpamTrash=true`,
        token,
      );
      const ids = Array.isArray(page.messages)
        ? page.messages
            .map((item) => object(item).id)
            .filter((id): id is string => typeof id === 'string')
            .slice(0, 50)
        : [];
      const records = await Promise.all(
        ids.map((id) => this.getMessage(id, token)),
      );
      return {
        ok: true,
        mode: 'gmail',
        operation: action.operation,
        affected: records.length,
        records,
      };
    }
    const ids = action.messageIds || [];
    if (action.operation === 'messages.get') {
      const records = await Promise.all(
        ids.map((id) => this.getMessage(id, token)),
      );
      return {
        ok: true,
        mode: 'gmail',
        operation: action.operation,
        affected: records.length,
        records,
      };
    }
    for (const messageId of ids) {
      const id = encodeURIComponent(messageId);
      if (action.operation === 'messages.modify_labels') {
        const addLabelIds = await this.resolveLabelIds(
          action.addLabels || [],
          token,
        );
        const removeLabelIds = await this.resolveLabelIds(
          action.removeLabels || [],
          token,
        );
        await this.json(`${GmailAdapter.base}/messages/${id}/modify`, token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            addLabelIds,
            removeLabelIds,
          }),
        });
      } else if (action.operation === 'messages.trash') {
        await this.json(`${GmailAdapter.base}/messages/${id}/trash`, token, {
          method: 'POST',
        });
      } else if (action.operation === 'messages.untrash') {
        await this.json(`${GmailAdapter.base}/messages/${id}/untrash`, token, {
          method: 'POST',
        });
      } else {
        throw new Error('Operation is not valid for Gmail');
      }
    }
    return {
      ok: true,
      mode: 'gmail',
      operation: action.operation,
      affected: ids.length,
    };
  }
}

function microsoftRecord(raw: unknown, mailboxId: string): InertEmailRecord {
  const message = object(raw);
  const sender = object(object(message.from).emailAddress);
  const body = object(message.body);
  const bodyContent = typeof body.content === 'string' ? body.content : '';
  const bodyIsHtml =
    typeof body.contentType === 'string' &&
    body.contentType.toLowerCase() === 'html';
  const categories = strings(message.categories);
  const hasAttachments = message.hasAttachments === true;
  return sanitizeEmail({
    provider: 'microsoft',
    mailboxId,
    messageId: String(message.id || ''),
    from:
      typeof sender.address === 'string'
        ? sender.address
        : typeof sender.name === 'string'
          ? sender.name
          : '',
    subject: typeof message.subject === 'string' ? message.subject : '',
    text: bodyIsHtml ? '' : bodyContent,
    html: bodyIsHtml ? bodyContent : '',
    attachmentNames: hasAttachments
      ? ['[provider-attachment-quarantined]']
      : [],
    attachmentContentTypes: hasAttachments ? ['application/octet-stream'] : [],
    ingestion: {
      rawBytes: 0,
      mimeParts: 1,
      maxDepth: 0,
      expandedBytes: Buffer.byteLength(bodyContent),
      encodingErrors: 0,
    },
    providerSpam: categories.includes('NanoClaw/ProviderSpam'),
  });
}

export class MicrosoftAdapter extends FixedProviderAdapter {
  private static readonly base = 'https://graph.microsoft.com/v1.0/me';
  private static readonly select =
    'id,subject,from,body,categories,hasAttachments';

  constructor(config: ProviderAdapterConfig) {
    super('microsoft', config);
  }

  protected async verifyIdentity(token: string): Promise<void> {
    const user = await this.json(
      `${MicrosoftAdapter.base}?$select=mail,userPrincipalName`,
      token,
    );
    const identities = [user.mail, user.userPrincipalName]
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.toLowerCase());
    if (!identities.includes(this.config.mailboxId.toLowerCase())) {
      throw new Error('Microsoft identity does not match configured mailbox');
    }
  }

  private headers(): Record<string, string> {
    return { Prefer: 'outlook.body-content-type="text"' };
  }

  private async getMessage(messageId: string, token: string) {
    const id = encodeURIComponent(messageId);
    return microsoftRecord(
      await this.json(
        `${MicrosoftAdapter.base}/messages/${id}?$select=${MicrosoftAdapter.select}`,
        token,
        { headers: this.headers() },
      ),
      this.config.mailboxId,
    );
  }

  protected async perform(
    action: BrokerActionRequest,
    token: string,
  ): Promise<AdapterActionResult> {
    if (action.operation === 'messages.list') {
      const page = await this.json(
        `${MicrosoftAdapter.base}/messages?$top=50&$select=${MicrosoftAdapter.select}`,
        token,
        { headers: this.headers() },
      );
      const records = Array.isArray(page.value)
        ? page.value
            .slice(0, 50)
            .map((item) => microsoftRecord(item, this.config.mailboxId))
        : [];
      return {
        ok: true,
        mode: 'microsoft',
        operation: action.operation,
        affected: records.length,
        records,
      };
    }
    const ids = action.messageIds || [];
    if (action.operation === 'messages.get') {
      const records = await Promise.all(
        ids.map((id) => this.getMessage(id, token)),
      );
      return {
        ok: true,
        mode: 'microsoft',
        operation: action.operation,
        affected: records.length,
        records,
      };
    }
    for (const messageId of ids) {
      const id = encodeURIComponent(messageId);
      if (action.operation === 'messages.modify_labels') {
        const current = await this.json(
          `${MicrosoftAdapter.base}/messages/${id}?$select=categories`,
          token,
        );
        const categories = new Set(strings(current.categories));
        for (const label of action.addLabels || []) categories.add(label);
        for (const label of action.removeLabels || []) categories.delete(label);
        await this.json(`${MicrosoftAdapter.base}/messages/${id}`, token, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ categories: [...categories] }),
        });
      } else if (
        action.operation === 'messages.move_deleted' ||
        action.operation === 'messages.restore'
      ) {
        await this.json(`${MicrosoftAdapter.base}/messages/${id}/move`, token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            destinationId:
              action.operation === 'messages.move_deleted'
                ? 'deleteditems'
                : 'inbox',
          }),
        });
      } else {
        throw new Error('Operation is not valid for Microsoft');
      }
    }
    return {
      ok: true,
      mode: 'microsoft',
      operation: action.operation,
      affected: ids.length,
    };
  }
}
