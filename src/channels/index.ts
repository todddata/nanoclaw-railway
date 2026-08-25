// Channel self-registration entrypoint. A deployment may set
// NANOCLAW_CHANNELS=slack to avoid loading or shipping unused integrations.
const configured = process.env.NANOCLAW_CHANNELS
  ?.split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

const enabled = new Set(configured?.length ? configured : ['discord', 'gmail', 'slack', 'whatsapp']);

if (enabled.has('discord')) await import('./discord.js');
if (enabled.has('gmail')) await import('./gmail.js');
if (enabled.has('slack')) await import('./slack.js');
if (enabled.has('whatsapp')) await import('./whatsapp.js');
