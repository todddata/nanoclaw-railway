import { NewMessage } from './types.js';

export interface CommandSourcePolicy {
  allowedChannel: string;
  allowedChatJid?: string;
}

export function isCommandPlaneChat(
  chatJid: string,
  policy: CommandSourcePolicy,
): boolean {
  if (!policy.allowedChannel) return true;
  if (!chatJid.startsWith(`${policy.allowedChannel}:`)) return false;
  return !policy.allowedChatJid || chatJid === policy.allowedChatJid;
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

  if (!isCommandPlaneChat(chatJid, policy)) {
    return {
      allowed: false,
      reason:
        policy.allowedChatJid && chatJid !== policy.allowedChatJid
          ? 'Conversation is outside the configured command plane.'
          : `Command destination does not belong to ${policy.allowedChannel}.`,
    };
  }

  if (message.chat_jid !== chatJid) {
    return {
      allowed: false,
      reason: 'Message destination does not match the receiving conversation.',
    };
  }

  return { allowed: true };
}
