import { NewMessage } from './types.js';

export interface CommandSourcePolicy {
  allowedChannel: string;
  allowedChatJid?: string;
}

export function validateCommandSource(
  chatJid: string,
  message: NewMessage,
  policy: CommandSourcePolicy,
): { allowed: true } | { allowed: false; reason: string } {
  if (!policy.allowedChannel) return { allowed: true };

  if (message.source_channel !== policy.allowedChannel) {
    return {
      allowed: false,
      reason: `Messages from ${message.source_channel || 'unknown'} are data-only; only ${policy.allowedChannel} can issue commands.`,
    };
  }

  if (!chatJid.startsWith(`${policy.allowedChannel}:`)) {
    return {
      allowed: false,
      reason: `Command destination does not belong to ${policy.allowedChannel}.`,
    };
  }

  if (message.chat_jid !== chatJid) {
    return {
      allowed: false,
      reason: 'Message destination does not match the receiving conversation.',
    };
  }

  if (policy.allowedChatJid && chatJid !== policy.allowedChatJid) {
    return {
      allowed: false,
      reason: 'Conversation is outside the configured command plane.',
    };
  }

  return { allowed: true };
}
