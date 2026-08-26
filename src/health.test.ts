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

function dependencies(
  overrides: Partial<Parameters<typeof evaluateHealth>[0]> = {},
): Parameters<typeof evaluateHealth>[0] {
  return {
    channels: [channel('slack', true)],
    agentCredentialConfigured: true,
    controlPlaneConfigured: true,
    mailBrokerEnabled: false,
    mailPilotConfigured: false,
    mailBrokerUrl: '',
    ...overrides,
  };
}

describe('deployment health', () => {
  it('is healthy when Slack and the hardened MailBroker are ready', async () => {
    const result = await evaluateHealth(
      dependencies({
        mailBrokerEnabled: true,
        mailPilotConfigured: true,
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
      }),
    );

    expect(result).toEqual({
      ok: true,
      components: {
        slack: 'ok',
        agentCredential: 'ok',
        controlPlane: 'ok',
        mailPilot: 'ok',
        mailBroker: 'ok',
      },
    });
  });

  it('fails closed when Slack is disconnected', async () => {
    const result = await evaluateHealth(
      dependencies({
        channels: [channel('slack', false)],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.components.slack).toBe('unavailable');
  });

  it('fails closed when enabled MailBroker controls are incomplete', async () => {
    const result = await evaluateHealth(
      dependencies({
        mailBrokerEnabled: true,
        mailPilotConfigured: true,
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
      }),
    );

    expect(result).toEqual({
      ok: false,
      components: {
        slack: 'ok',
        agentCredential: 'ok',
        controlPlane: 'ok',
        mailPilot: 'ok',
        mailBroker: 'unavailable',
      },
    });
  });

  it('does not require MailBroker when mailbox automation is disabled', async () => {
    const result = await evaluateHealth(dependencies());

    expect(result).toEqual({
      ok: true,
      components: {
        slack: 'ok',
        agentCredential: 'ok',
        controlPlane: 'ok',
        mailPilot: 'disabled',
        mailBroker: 'disabled',
      },
    });
  });

  it.each([
    ['agent credential', { agentCredentialConfigured: false }],
    ['owner-only control plane', { controlPlaneConfigured: false }],
    [
      'agent-side mailbox profile',
      { mailBrokerEnabled: true, mailPilotConfigured: false },
    ],
  ])('fails closed without %s', async (_name, overrides) => {
    const result = await evaluateHealth(dependencies(overrides));
    expect(result.ok).toBe(false);
  });
});
