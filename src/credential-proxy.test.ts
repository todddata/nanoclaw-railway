import { describe, expect, it } from 'vitest';

import { hasCredentialMaterial } from './credential-proxy.js';

describe('credential proxy readiness', () => {
  it('requires one supported Anthropic credential', () => {
    expect(hasCredentialMaterial({})).toBe(false);
    expect(hasCredentialMaterial({ ANTHROPIC_API_KEY: 'configured' })).toBe(
      true,
    );
    expect(
      hasCredentialMaterial({ CLAUDE_CODE_OAUTH_TOKEN: 'configured' }),
    ).toBe(true);
    expect(hasCredentialMaterial({ ANTHROPIC_AUTH_TOKEN: 'configured' })).toBe(
      true,
    );
  });
});
