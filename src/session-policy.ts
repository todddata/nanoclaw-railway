import { createHash } from 'crypto';

const RESTRICTED_AGENT_POLICY_VERSION = 'restricted-mailbroker-v1';

export function restrictedAgentPolicyFingerprint(input: {
  mailCleanupEnabled: boolean;
  mailboxId?: string;
  provider?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: RESTRICTED_AGENT_POLICY_VERSION,
        mailCleanupEnabled: input.mailCleanupEnabled,
        mailboxId: input.mailboxId || '',
        provider: input.provider || '',
      }),
    )
    .digest('hex');
}
