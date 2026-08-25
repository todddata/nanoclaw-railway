import { App, LogLevel } from '@slack/bolt';
import type { GenericMessageEvent, BotMessageEvent } from '@slack/types';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Slack's chat.postMessage API limits text to ~4000 characters per call.
// Messages exceeding this are split into sequential chunks.
const MAX_MESSAGE_LENGTH = 4000;

// The message subtypes we process. Bolt delivers all subtypes via app.event('message');
// we filter to regular messages (GenericMessageEvent, subtype undefined) and bot messages
// (BotMessageEvent, subtype 'bot_message') so we can track our own output.
type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App;
  private botUserId: string | undefined;
  private botId: string | undefined;
  private connected = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private userNameCache = new Map<string, string>();
  // Track active thread per channel: channelId → thread_ts
  // When a user posts in a channel, we start a thread on their message.
  // When a user posts in an existing thread, we reply in that thread.
  private activeThread = new Map<string, string>();
  // Visible placeholder reply while NanoClaw is processing. The final answer
  // replaces this message so users always see immediate activity.
  private workingMessages = new Map<string, { ts: string; threadTs: string }>();

  private opts: SlackChannelOpts;

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;

    // Read tokens — on Railway from process.env, locally from .env
    const env = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
    const botToken = env.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
    const appToken = env.SLACK_APP_TOKEN || process.env.SLACK_APP_TOKEN;

    if (!botToken || !appToken) {
      throw new Error(
        'SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set (Railway service config or .env locally)',
      );
    }

    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // Use app.event('message') instead of app.message() to capture all
    // message subtypes including bot_message (needed to track our own output)
    this.app.event('message', async ({ event }) => {
      // Bolt's event type is the full MessageEvent union (17+ subtypes).
      // We filter on subtype first, then narrow to the two types we handle.
      const subtype = (event as { subtype?: string }).subtype;
      if (subtype && subtype !== 'bot_message') return;

      // After filtering, event is either GenericMessageEvent or BotMessageEvent
      const msg = event as HandledMessageEvent;

      if (!msg.text) return;

      const jid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type !== 'im';

      // Always report metadata for group discovery
      this.opts.onChatMetadata(jid, timestamp, undefined, 'slack', isGroup);

      // Only deliver full messages for registered groups
      const groups = this.opts.registeredGroups();
      if (!groups[jid]) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
      const isOwnBotMessage =
        msg.user === this.botUserId ||
        (!!msg.bot_id && msg.bot_id === this.botId);

      let senderName: string;
      if (isOwnBotMessage) {
        senderName = ASSISTANT_NAME;
      } else if (isBotMessage) {
        senderName =
          ('username' in msg && msg.username) || msg.bot_id || 'unknown bot';
      } else {
        senderName =
          (msg.user ? await this.resolveUserName(msg.user) : undefined) ||
          msg.user ||
          'unknown';
      }

      // Determine thread context.
      // For threaded messages, thread_ts is the parent; for top-level, use msg.ts
      // (the bot will create a thread on it).
      const incomingThreadTs = (msg as GenericMessageEvent).thread_ts;
      const threadId = incomingThreadTs || msg.ts;

      // Track active thread per channel for outbound replies.
      if (!isBotMessage) {
        this.activeThread.set(msg.channel, threadId);
      }

      // Translate Slack <@UBOTID> mentions into TRIGGER_PATTERN format.
      // Slack encodes @mentions as <@U12345>, which won't match TRIGGER_PATTERN
      // (e.g., ^@<ASSISTANT_NAME>\b), so we prepend the trigger when the bot is @mentioned.
      let content = msg.text;
      if (this.botUserId && !isBotMessage) {
        const mentionPattern = `<@${this.botUserId}>`;
        if (
          content.includes(mentionPattern) &&
          !TRIGGER_PATTERN.test(content)
        ) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      this.opts.onMessage(jid, {
        id: msg.ts,
        chat_jid: jid,
        sender: msg.user || msg.bot_id || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isOwnBotMessage,
        is_bot_message: isBotMessage,
        thread_id: threadId,
      });
    });
  }

  async connect(): Promise<void> {
    await this.app.start();

    // Get bot's own user ID for self-message detection.
    // Resolve this BEFORE setting connected=true so that messages arriving
    // during startup can correctly detect bot-sent messages.
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string;
      this.botId = auth.bot_id as string;
      logger.info({ botUserId: this.botUserId }, 'Connected to Slack');
    } catch (err) {
      logger.warn({ err }, 'Connected to Slack but failed to get bot user ID');
    }

    this.connected = true;

    // Flush any messages queued before connection
    await this.flushOutgoingQueue();

    // Sync channel names on startup
    await this.syncGroups();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Slack disconnected, message queued',
      );
      return;
    }

    try {
      const threadTs = this.activeThread.get(channelId);
      const workingMessage = this.workingMessages.get(channelId);
      let replacedWorkingMessage = false;

      if (workingMessage && workingMessage.threadTs === threadTs) {
        try {
          await this.app.client.chat.update({
            channel: channelId,
            ts: workingMessage.ts,
            text: text.slice(0, MAX_MESSAGE_LENGTH),
          });
          this.workingMessages.delete(channelId);
          replacedWorkingMessage = true;
        } catch (err) {
          logger.warn(
            { jid, err },
            'Failed to replace Slack working message; sending a new reply',
          );
          this.workingMessages.delete(channelId);
          await this.app.client.chat
            .delete({ channel: channelId, ts: workingMessage.ts })
            .catch(() => undefined);
        }
      }

      // Slack limits messages to ~4000 characters; split if needed
      if (!replacedWorkingMessage && text.length <= MAX_MESSAGE_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
          thread_ts: threadTs,
        });
      } else {
        const start = replacedWorkingMessage ? MAX_MESSAGE_LENGTH : 0;
        for (let i = start; i < text.length; i += MAX_MESSAGE_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_MESSAGE_LENGTH),
            thread_ts: threadTs,
          });
        }
      }
      logger.info({ jid, length: text.length, threadTs }, 'Slack message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Slack message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = this.activeThread.get(channelId);

    // Scheduled tasks and startup work may not have an inbound Slack thread.
    if (!this.connected || !threadTs) return;

    try {
      await this.app.client.assistant.threads.setStatus({
        channel_id: channelId,
        thread_ts: threadTs,
        status: isTyping ? 'is working on your response…' : '',
        loading_messages: isTyping
          ? ['Thinking…', 'Checking the details…', 'Writing a response…']
          : undefined,
      });
    } catch (err) {
      logger.warn(
        { jid, err },
        isTyping
          ? 'Failed to set Slack response status'
          : 'Failed to clear Slack response status',
      );
    }

    if (isTyping) {
      if (!this.workingMessages.has(channelId)) {
        try {
          const result = await this.app.client.chat.postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: ':hourglass_flowing_sand: Working on your response…',
          });
          if (result.ts) {
            this.workingMessages.set(channelId, {
              ts: result.ts,
              threadTs,
            });
          }
        } catch (err) {
          logger.warn({ jid, err }, 'Failed to post Slack working message');
        }
      }
    } else {
      const workingMessage = this.workingMessages.get(channelId);
      if (workingMessage) {
        this.workingMessages.delete(channelId);
        try {
          await this.app.client.chat.delete({
            channel: channelId,
            ts: workingMessage.ts,
          });
        } catch (err) {
          logger.warn({ jid, err }, 'Failed to clear Slack working message');
        }
      }
    }
  }

  /**
   * Sync channel metadata from Slack.
   * Fetches channels the bot is a member of and stores their names in the DB.
   * Also reports metadata so channels appear in available_groups.
   */
  async syncGroups(_force?: boolean): Promise<void> {
    try {
      logger.info('Syncing channel metadata from Slack...');
      let cursor: string | undefined;
      let count = 0;
      const now = new Date().toISOString();

      do {
        const result = await this.app.client.conversations.list({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of result.channels || []) {
          if (ch.id && ch.name && ch.is_member) {
            const jid = `slack:${ch.id}`;
            updateChatName(jid, ch.name);
            // Report metadata so these channels appear in available_groups
            this.opts.onChatMetadata(jid, now, ch.name, 'slack', true);
            count++;
          }
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);

      logger.info({ count }, 'Slack channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Slack channel metadata');
    }
  }

  private async resolveUserName(userId: string): Promise<string | undefined> {
    if (!userId) return undefined;

    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await this.app.client.users.info({ user: userId });
      const name = result.user?.real_name || result.user?.name;
      if (name) this.userNameCache.set(userId, name);
      return name;
    } catch (err) {
      logger.debug({ userId, err }, 'Failed to resolve Slack user name');
      return undefined;
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Slack outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const channelId = item.jid.replace(/^slack:/, '');
        await this.app.client.chat.postMessage({
          channel: channelId,
          text: item.text,
        });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Slack message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']);
  const botToken = envVars.SLACK_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  const appToken = envVars.SLACK_APP_TOKEN || process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    logger.warn('Slack: SLACK_BOT_TOKEN or SLACK_APP_TOKEN not set');
    return null;
  }
  return new SlackChannel(opts);
});
