import {
  BrokerActionRequest,
  BrokerActionResult,
  MockMessageView,
} from './types.js';

const GMAIL_ONLY = new Set(['messages.trash', 'messages.untrash']);
const MICROSOFT_ONLY = new Set(['messages.move_deleted', 'messages.restore']);

export class MockMailboxAdapter {
  private readonly messages = new Map<string, MockMessageView>();

  constructor(seed: MockMessageView[] = []) {
    for (const message of seed) this.put(message);
  }

  private key(
    message: Pick<MockMessageView, 'provider' | 'mailboxId' | 'messageId'>,
  ): string {
    return `${message.provider}\u0000${message.mailboxId}\u0000${message.messageId}`;
  }

  private put(message: MockMessageView): void {
    this.messages.set(this.key(message), {
      ...message,
      labels: [...new Set(message.labels)],
    });
  }

  snapshot(): MockMessageView[] {
    return [...this.messages.values()].map((message) => ({
      ...message,
      labels: [...message.labels],
    }));
  }

  execute(action: BrokerActionRequest): Omit<BrokerActionResult, 'grantId'> {
    if (action.provider === 'gmail' && MICROSOFT_ONLY.has(action.operation)) {
      throw new Error('Operation is not valid for Gmail');
    }
    if (action.provider === 'microsoft' && GMAIL_ONLY.has(action.operation)) {
      throw new Error('Operation is not valid for Microsoft');
    }

    const candidates = this.snapshot().filter(
      (message) =>
        message.provider === action.provider &&
        message.mailboxId === action.mailboxId &&
        (!action.messageIds || action.messageIds.includes(message.messageId)),
    );

    if (action.operation === 'messages.modify_labels') {
      for (const message of candidates) {
        const labels = new Set(message.labels);
        for (const label of action.addLabels || []) labels.add(label);
        for (const label of action.removeLabels || []) labels.delete(label);
        this.put({ ...message, labels: [...labels] });
      }
    } else if (action.operation === 'messages.trash') {
      for (const message of candidates)
        this.put({ ...message, location: 'trash' });
    } else if (action.operation === 'messages.untrash') {
      for (const message of candidates)
        this.put({ ...message, location: 'inbox' });
    } else if (action.operation === 'messages.move_deleted') {
      for (const message of candidates)
        this.put({ ...message, location: 'deleted' });
    } else if (action.operation === 'messages.restore') {
      for (const message of candidates)
        this.put({ ...message, location: 'inbox' });
    }

    return {
      ok: true,
      mode: 'mock',
      operation: action.operation,
      affected: candidates.length,
      messages:
        action.operation === 'messages.list' ||
        action.operation === 'messages.get'
          ? candidates
          : undefined,
    };
  }
}
