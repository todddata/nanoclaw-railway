import { describe, expect, it } from 'vitest';

import { restrictedAgentPolicyFingerprint } from './session-policy.js';

describe('restricted agent policy fingerprint', () => {
  it('is stable for an unchanged capability profile', () => {
    const profile = {
      mailCleanupEnabled: true,
      mailboxId: 'pilot@example.com',
      provider: 'microsoft',
    };
    expect(restrictedAgentPolicyFingerprint(profile)).toBe(
      restrictedAgentPolicyFingerprint(profile),
    );
  });

  it('changes when mailbox capability scope changes', () => {
    const enabled = restrictedAgentPolicyFingerprint({
      mailCleanupEnabled: true,
      mailboxId: 'pilot@example.com',
      provider: 'microsoft',
    });
    const disabled = restrictedAgentPolicyFingerprint({
      mailCleanupEnabled: false,
      mailboxId: 'pilot@example.com',
      provider: 'microsoft',
    });
    expect(enabled).not.toBe(disabled);
  });
});
