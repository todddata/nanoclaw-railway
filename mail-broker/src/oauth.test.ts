import assert from 'node:assert/strict';
import test from 'node:test';

import {
  googleTokenSource,
  microsoftTokenSource,
  RefreshingOAuthTokenSource,
} from './oauth.js';

test('refreshes at a fixed endpoint, requests fixed scope, and caches the token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({ access_token: 'access-1', expires_in: 3600 });
  };
  const source = googleTokenSource({
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh',
    fetch,
    now: () => 1_000,
  });
  assert.equal(await source.getAccessToken(), 'access-1');
  assert.equal(await source.getAccessToken(), 'access-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://oauth2.googleapis.com/token');
  const body = calls[0]?.init?.body as URLSearchParams;
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(
    body.get('scope'),
    'https://www.googleapis.com/auth/gmail.modify',
  );
});

test('does not expose provider response bodies when refresh fails', async () => {
  const source = new RefreshingOAuthTokenSource({
    tokenEndpoint: 'https://tokens.example.test/oauth',
    clientId: 'client',
    refreshToken: 'refresh',
    fetch: async () =>
      new Response('secret-provider-diagnostic', { status: 400 }),
  });
  await assert.rejects(
    () => source.getAccessToken(),
    (error: Error) =>
      error.message === 'OAuth token refresh failed' &&
      !error.message.includes('secret-provider-diagnostic'),
  );
});

test('rejects an unsafe Microsoft tenant before constructing a token URL', () => {
  assert.throws(
    () =>
      microsoftTokenSource('../attacker', {
        clientId: 'client',
        refreshToken: 'refresh',
      }),
    /tenant ID is invalid/,
  );
});
