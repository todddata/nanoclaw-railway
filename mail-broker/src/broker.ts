import { verifyCapability } from './capability.js';
import { MockMailboxAdapter } from './mock-adapter.js';
import { authorizeAction, parseActionRequest } from './policy.js';
import {
  BrokerActionRequest,
  BrokerActionResult,
  MailboxAdapter,
} from './types.js';

export interface BrokerConfig {
  secret: string;
  allowedSlackUser: string;
  allowedSlackChannel: string;
  killSwitch?: boolean;
  revokedGrantIds?: Iterable<string>;
  adapter?: MailboxAdapter;
  now?: () => Date;
  audit?: (event: Record<string, unknown>) => void;
  policyVersion?: string;
  modelVersion?: string;
  denialAlertThreshold?: number;
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

export function brokerHealth(
  mode: string,
  killSwitch: boolean,
  providerConfigured = mode === 'mock',
) {
  const configuredMode =
    mode === 'mock' ||
    ((mode === 'gmail' || mode === 'microsoft') && providerConfigured);
  return {
    status: configuredMode ? 200 : 503,
    body: {
      ok: configuredMode,
      mode,
      actionsEnabled: configuredMode && !killSwitch,
    },
  };
}

export class BrokerEngine {
  private readonly actionCounts = new Map<string, number>();
  private readonly idempotencyResults = new Map<string, BrokerActionResult>();
  private readonly revokedGrantIds: Set<string>;
  private denialWindowStartedAt = 0;
  private denialCount = 0;
  readonly adapter: MailboxAdapter;

  constructor(private readonly config: BrokerConfig) {
    this.revokedGrantIds = new Set(config.revokedGrantIds || []);
    this.adapter = config.adapter || new MockMailboxAdapter();
  }

  async execute(raw: unknown): Promise<BrokerActionResult> {
    if (this.config.killSwitch) {
      this.recordRejection('kill_switch_active');
      throw new BrokerError(
        'Broker kill switch is active',
        503,
        'broker_disabled',
      );
    }
    if (
      !this.config.secret ||
      !this.config.allowedSlackUser ||
      !this.config.allowedSlackChannel
    ) {
      throw new BrokerError(
        'Broker is not configured',
        503,
        'broker_not_configured',
      );
    }

    let action: BrokerActionRequest | undefined;
    try {
      action = parseActionRequest(raw);
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

      // The authorized intent is written before the adapter is allowed to
      // mutate provider state. A required audit sink failure therefore fails
      // closed with no mailbox side effect.
      this.config.audit?.({
        event: 'mail_action_authorized',
        grantId: capability.grantId,
        taskId: capability.source.taskId,
        userId: capability.source.userId,
        mailboxId: action.mailboxId,
        operation: action.operation,
        reasonCode: action.reasonCode,
        messageRefs: action.messageIds || [],
        policyVersion: this.config.policyVersion || 'mail-policy-v1',
        modelVersion: this.config.modelVersion || 'none',
        outcome: 'authorized',
        affected: requestedActions,
      });

      const adapterResult = await this.adapter.execute(action);
      const result: BrokerActionResult = {
        ...adapterResult,
        grantId: capability.grantId,
      };
      this.config.audit?.({
        event: 'mail_action_completed',
        grantId: capability.grantId,
        taskId: capability.source.taskId,
        userId: capability.source.userId,
        mailboxId: action.mailboxId,
        operation: action.operation,
        reasonCode: action.reasonCode,
        messageRefs: action.messageIds || [],
        policyVersion: this.config.policyVersion || 'mail-policy-v1',
        modelVersion: this.config.modelVersion || 'none',
        outcome: 'completed',
        affected: result.affected,
      });
      this.actionCounts.set(capability.grantId, actionCount + requestedActions);
      this.idempotencyResults.set(idempotencyScope, result);
      return result;
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      try {
        this.recordRejection(
          error instanceof Error ? error.message : 'unknown_error',
          action,
        );
      } catch {
        throw new BrokerError(
          'Required audit storage is unavailable',
          503,
          'audit_unavailable',
        );
      }
      throw new BrokerError(
        error instanceof Error ? error.message : 'Request rejected',
      );
    }
  }

  private recordRejection(reason: string, action?: BrokerActionRequest): void {
    this.config.audit?.({
      event: 'mail_action_rejected',
      outcome: 'rejected',
      error: reason,
      mailboxId: action?.mailboxId,
      messageRefs: action?.messageIds || [],
      operation: action?.operation,
      reasonCode: action?.reasonCode || 'request_rejected',
      policyVersion: this.config.policyVersion || 'mail-policy-v1',
      modelVersion: this.config.modelVersion || 'none',
    });

    const timestamp = (this.config.now?.() || new Date()).getTime();
    if (
      !this.denialWindowStartedAt ||
      timestamp - this.denialWindowStartedAt > 60_000
    ) {
      this.denialWindowStartedAt = timestamp;
      this.denialCount = 0;
    }
    this.denialCount += 1;
    const threshold = Math.max(2, this.config.denialAlertThreshold || 5);
    if (this.denialCount >= threshold) {
      this.config.audit?.({
        event: 'mail_security_alert',
        outcome: 'alert',
        reasonCode: 'repeated_denials',
        policyVersion: this.config.policyVersion || 'mail-policy-v1',
        modelVersion: this.config.modelVersion || 'none',
        affected: this.denialCount,
      });
      this.denialCount = 0;
      this.denialWindowStartedAt = timestamp;
    }
  }
}
