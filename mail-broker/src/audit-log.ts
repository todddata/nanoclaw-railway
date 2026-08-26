import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';

export interface MailAuditInput {
  event:
    | 'mail_action_authorized'
    | 'mail_action_completed'
    | 'mail_action_rejected'
    | 'mail_security_alert';
  timestamp?: string;
  mailboxId?: string;
  messageRefs?: string[];
  operation?: string;
  reasonCode?: string;
  policyVersion?: string;
  modelVersion?: string;
  grantId?: string;
  taskId?: string;
  userId?: string;
  outcome: 'authorized' | 'completed' | 'rejected' | 'alert';
  affected?: number;
}

export interface MailAuditEvent extends Required<Pick<MailAuditInput, 'event' | 'outcome'>> {
  version: 1;
  eventId: string;
  timestamp: string;
  mailboxId?: string;
  messageRefs?: string[];
  operation?: string;
  reasonCode?: string;
  policyVersion?: string;
  modelVersion?: string;
  grantId?: string;
  taskId?: string;
  userId?: string;
  affected?: number;
  previousHash: string;
  hash: string;
}

const ZERO_HASH = '0'.repeat(64);

function eventHash(event: Omit<MailAuditEvent, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export class AppendOnlyAuditLog {
  private previousHash = ZERO_HASH;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const events = this.readAndVerify();
      this.previousHash = events.at(-1)?.hash || ZERO_HASH;
    }
    // Probe the configured journal during startup. A read-only or unavailable
    // volume must prevent readiness instead of failing on the first action.
    appendFileSync(this.path, '', { encoding: 'utf8', flag: 'a', mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  append(input: MailAuditInput): MailAuditEvent {
    const unsigned: Omit<MailAuditEvent, 'hash'> = {
      version: 1,
      eventId: randomUUID(),
      timestamp: input.timestamp || new Date().toISOString(),
      event: input.event,
      outcome: input.outcome,
      mailboxId: input.mailboxId,
      messageRefs: input.messageRefs ? [...input.messageRefs] : undefined,
      operation: input.operation,
      reasonCode: input.reasonCode,
      policyVersion: input.policyVersion,
      modelVersion: input.modelVersion,
      grantId: input.grantId,
      taskId: input.taskId,
      userId: input.userId,
      affected: input.affected,
      previousHash: this.previousHash,
    };
    const event = { ...unsigned, hash: eventHash(unsigned) };
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    });
    chmodSync(this.path, 0o600);
    this.previousHash = event.hash;
    return event;
  }

  readAndVerify(): MailAuditEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    let previousHash = ZERO_HASH;
    return lines.map((line) => {
      const event = JSON.parse(line) as MailAuditEvent;
      const { hash, ...unsigned } = event;
      if (
        event.version !== 1 ||
        event.previousHash !== previousHash ||
        hash !== eventHash(unsigned)
      ) {
        throw new Error('Mail audit chain verification failed');
      }
      previousHash = hash;
      return event;
    });
  }

  digest() {
    const events = this.readAndVerify();
    const counts: Record<string, number> = {};
    for (const event of events) {
      const key = `${event.outcome}:${event.operation || event.event}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return {
      verified: true,
      eventCount: events.length,
      latestHash: events.at(-1)?.hash || ZERO_HASH,
      counts,
    };
  }
}
