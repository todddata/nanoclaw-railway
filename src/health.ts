import { createServer, Server } from 'http';

import { Channel } from './types.js';

interface MailBrokerHealth {
  ok?: boolean;
  auditPersistent?: boolean;
  grantExchangeConfigured?: boolean;
}

export interface HealthDependencies {
  channels: readonly Channel[];
  mailBrokerEnabled: boolean;
  mailBrokerUrl: string;
  fetchImpl?: typeof fetch;
}

export interface HealthResult {
  ok: boolean;
  components: {
    slack: 'ok' | 'unavailable';
    mailBroker: 'ok' | 'disabled' | 'unavailable';
  };
}

export async function evaluateHealth(
  dependencies: HealthDependencies,
): Promise<HealthResult> {
  const slackConnected = dependencies.channels.some(
    (channel) => channel.name === 'slack' && channel.isConnected(),
  );
  let mailBroker: HealthResult['components']['mailBroker'] = 'disabled';

  if (dependencies.mailBrokerEnabled) {
    if (!dependencies.mailBrokerUrl) {
      mailBroker = 'unavailable';
    } else {
      try {
        const response = await (dependencies.fetchImpl || fetch)(
          new URL('/health', dependencies.mailBrokerUrl),
          { signal: AbortSignal.timeout(2_000) },
        );
        const body = (await response.json()) as MailBrokerHealth;
        mailBroker =
          response.ok &&
          body.ok === true &&
          body.auditPersistent === true &&
          body.grantExchangeConfigured === true
            ? 'ok'
            : 'unavailable';
      } catch {
        mailBroker = 'unavailable';
      }
    }
  }

  return {
    ok: slackConnected && mailBroker !== 'unavailable',
    components: {
      slack: slackConnected ? 'ok' : 'unavailable',
      mailBroker,
    },
  };
}

export function startHealthServer(
  dependencies: HealthDependencies,
  port: number,
  host = '0.0.0.0',
): Promise<Server> {
  const server = createServer(async (request, response) => {
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      request.url !== '/healthz'
    ) {
      response.writeHead(404, {
        'cache-control': 'no-store',
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : '{"ok":false}');
      return;
    }

    const health = await evaluateHealth(dependencies);
    response.writeHead(health.ok ? 200 : 503, {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-content-type-options': 'nosniff',
    });
    response.end(
      request.method === 'HEAD'
        ? undefined
        : JSON.stringify({
            ok: health.ok,
            components: health.components,
          }),
    );
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
