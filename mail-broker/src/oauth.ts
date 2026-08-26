export interface OAuthTokenSource {
  getAccessToken(): Promise<string>;
}

export interface RefreshingTokenConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  scope?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

export class RefreshingOAuthTokenSource implements OAuthTokenSource {
  private accessToken = '';
  private expiresAt = 0;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly config: RefreshingTokenConfig) {
    if (
      !config.tokenEndpoint.startsWith('https://') ||
      !config.clientId ||
      !config.refreshToken
    ) {
      throw new Error('OAuth token source is not configured');
    }
    this.fetch = config.fetch || globalThis.fetch;
    this.now = config.now || Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.expiresAt - 60_000 > this.now()) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: this.config.refreshToken,
    });
    if (this.config.clientSecret) {
      body.set('client_secret', this.config.clientSecret);
    }
    if (this.config.scope) body.set('scope', this.config.scope);

    const response = await this.fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
    });
    if (!response.ok) throw new Error('OAuth token refresh failed');
    const value = (await response.json()) as TokenResponse;
    if (
      typeof value.access_token !== 'string' ||
      value.access_token.length < 1 ||
      typeof value.expires_in !== 'number' ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in < 120
    ) {
      throw new Error('OAuth token response was invalid');
    }
    this.accessToken = value.access_token;
    this.expiresAt = this.now() + value.expires_in * 1_000;
    return this.accessToken;
  }
}

export function googleTokenSource(
  config: Omit<RefreshingTokenConfig, 'tokenEndpoint' | 'scope'>,
): OAuthTokenSource {
  return new RefreshingOAuthTokenSource({
    ...config,
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/gmail.modify',
  });
}

export function microsoftTokenSource(
  tenantId: string,
  config: Omit<RefreshingTokenConfig, 'tokenEndpoint' | 'scope'>,
): OAuthTokenSource {
  if (!/^[a-zA-Z0-9.-]{1,128}$/.test(tenantId)) {
    throw new Error('Microsoft tenant ID is invalid');
  }
  return new RefreshingOAuthTokenSource({
    ...config,
    tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    scope: 'offline_access Mail.ReadWrite User.Read',
  });
}
