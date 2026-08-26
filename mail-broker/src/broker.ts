import { verifyCapability } from './capability.js';
import { MockMailboxAdapter } from './mock-adapter.js';
import { authorizeAction, parseActionRequest } from './policy.js';
import { BrokerActionResult } from './types.js';

export interface BrokerConfig {
  secret: string;
  allowedSlackUser: string;
  allowedSlackChannel: string;
  killSwitch?: boolean;
  revokedGrantIds?: Iterable<string>;
  adapter?: MockMailboxAdapter;
  now?: () => Date;
  audit?: (event: Record<string, unknown>) => void;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status = 403,
    readonly code = 'request_rejected',
  ) {
    super(message);
  }
}

export class BrokerEngine {
  private readonly actionCounts = new Map<string, number>();
  private readonly idempotencyResults = new Map<string, BrokerActionResult>();
  private readonly revokedGrantIds: Set<string>;
  readonly adapter: MockMailboxAdapter;

  constructor(private readonly config: BrokerConfig) {
    this.revokedGrantIds = new Set(config.revokedGrantIds || []);
    this.adapter = config.adapter || new MockMailboxAdapter();
  }

  execute(raw: unknown): BrokerActionResult {
    if (this.config.killSwitch) {
      throw new BrokerError('Broker kill switch is active', 503, 'broker_disabled');
    }
    if (
      !this.config.secret ||
      !this.config.allowedSlackUser ||
      !this.config.allowedSlackChannel
    ) {
      throw new BrokerError('Broker is not configured', 503, 'broker_not_configured');
    }

    try {
      const action = parseActionRequest(raw);
      const capability = verifyCapability(
        action.capability,
        this.config.secret,
        this.config.now?.(),
      );
      if (this.revokedGrantIds.has(capability.grantId)) {
        throw new Error('Capability grant has been revoked');
      }
      authorizeAction(action, capability);
      if (
        capability.source.userId !== this.config.allowedSlackUser ||
        capability.source.channelId !== this.config.allowedSlackChannel
      ) {
        throw new Error('Slack source is outside broker policy');
      }

      const idempotencyScope = `${capability.grantId}\u0000${action.idempotencyKey}`;
      const existing = this.idempotencyResults.get(idempotencyScope);
      if (existing) return existing;

      const actionCount = this.actionCounts.get(capability.grantId) || 0;
      const requestedActions = Math.max(1, action.messageIds?.length || 0);
      if (actionCount + requestedActions > capability.maxActions) {
        throw new Error('Capability action limit exceeded');
      }

      const adapterResult = this.adapter.execute(action);
      const result: BrokerActionResult = {
        ...adapterResult,
        grantId: capability.grantId,
      };
      this.actionCounts.set(capability.grantId, actionCount + requestedActions);
      this.idempotencyResults.set(idempotencyScope, result);
      this.config.audit?.({
        event: 'mail_action_authorized',
        grantId: capability.grantId,
        taskId: capability.source.taskId,
        userId: capability.source.userId,
        mailboxId: action.mailboxId,
        operation: action.operation,
        reasonCode: action.reasonCode,
        affected: result.affected,
      });
      return result;
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      this.config.audit?.({
        event: 'mail_action_rejected',
        error: error instanceof Error ? error.message : 'unknown_error',
      });
      throw new BrokerError(
        error instanceof Error ? error.message : 'Request rejected',
      );
    }
  }
}
