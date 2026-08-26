import { describe, expect, it, vi } from 'vitest';

import { evaluateHealth } from './health.js';
import { Channel } from './types.js';

function channel(name: string, connected: boolean): Channel {
  return {
    name,
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: () => connected,
    ownsJid: () => false,
    disconnect: vi.fn(),
  };
}

describe('deployment health', () => {
  it('is healthy when Slack and the hardened MailBroker are ready', async () => {
    const result = await evaluateHealth({
      channels: [channel('slack', true)],
      mailBrokerEnabled: true,
      mailBrokerUrl: 'http://mail-broker.internal:8080',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            auditPersistent: true,
            grantExchangeConfigured: true,
          }),
          { status: 200 },
        ),
      ),
    });

    expect(result).toEqual({
      ok: true,
      components: { slack: 'ok', mailBroker: 'ok' },
    });
  });

  it('fails closed when Slack is disconnected', async () => {
    const result = await evaluateHealth({
      channels: [channel('slack', false)],
      mailBrokerEnabled: false,
      mailBrokerUrl: '',
    });

    expect(result.ok).toBe(false);
    expect(result.components.slack).toBe('unavailable');
  });

  it('fails closed when enabled MailBroker controls are incomplete', async () => {
    const result = await evaluateHealth({
      channels: [channel('slack', true)],
      mailBrokerEnabled: true,
      mailBrokerUrl: 'http://mail-broker.internal:8080',
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            auditPersistent: false,
            grantExchangeConfigured: true,
          }),
          { status: 200 },
        ),
      ),
    });

    expect(result).toEqual({
      ok: false,
      components: { slack: 'ok', mailBroker: 'unavailable' },
    });
  });

  it('does not require MailBroker when mailbox automation is disabled', async () => {
    const result = await evaluateHealth({
      channels: [channel('slack', true)],
      mailBrokerEnabled: false,
      mailBrokerUrl: '',
    });

    expect(result).toEqual({
      ok: true,
      components: { slack: 'ok', mailBroker: 'disabled' },
    });
  });
});
