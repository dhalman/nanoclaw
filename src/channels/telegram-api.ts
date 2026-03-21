/**
 * Telegram API helpers — stateless functions that operate on the Jarvis bot's Api instance.
 * Handles: send, edit, delete, pin, unpin, react, remove reaction, send photo/video.
 */
import { Api, InputFile } from 'grammy';

import { logger } from '../logger.js';
import { storeMessageDirect } from '../db.js';

// Jarvis bot API instance — set by telegram-jarvis.ts on init
let jarvisApi: Api | null = null;

export function setJarvisApi(api: Api | null): void {
  jarvisApi = api;
}

export function getJarvisApi(): Api | null {
  return jarvisApi;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 */
export async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number; reply_to_message_id?: number } = {},
): Promise<number | null> {
  const opts: Record<string, unknown> = { ...options, parse_mode: 'Markdown' };
  if (options.reply_to_message_id) {
    opts.reply_parameters = { message_id: options.reply_to_message_id };
    delete opts.reply_to_message_id;
  }
  try {
    const msg = await api.sendMessage(chatId, text, opts);
    return msg.message_id;
  } catch (err) {
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    try {
      delete opts.parse_mode;
      const msg = await api.sendMessage(chatId, text, opts);
      return msg.message_id;
    } catch {
      return null;
    }
  }
}

export async function sendJarvisMessage(
  chatId: string,
  text: string,
  replyToMessageId?: number,
): Promise<number | null> {
  if (!jarvisApi) {
    logger.warn('Jarvis bot not initialized, cannot send message');
    return null;
  }
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  const MAX_LENGTH = 4096;
  const replyOpts = replyToMessageId
    ? { reply_to_message_id: replyToMessageId }
    : {};
  try {
    let firstMessageId: number | null = null;
    if (text.length <= MAX_LENGTH) {
      firstMessageId = await sendTelegramMessage(
        jarvisApi,
        numericId,
        text,
        replyOpts,
      );
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        const msgId = await sendTelegramMessage(
          jarvisApi,
          numericId,
          text.slice(i, i + MAX_LENGTH),
        );
        if (firstMessageId === null) firstMessageId = msgId;
      }
    }
    logger.info({ chatId, length: text.length }, 'Jarvis message sent');
    // Store bot response in message DB for audit trail and feedback loop
    try {
      storeMessageDirect({
        id: firstMessageId ? String(firstMessageId) : `bot-${Date.now()}`,
        chat_jid: chatId,
        sender: 'bot',
        sender_name: 'Jarvis',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    } catch (err) {
      logger.debug({ chatId, err }, 'Failed to store bot response in DB');
    }
    return firstMessageId;
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Jarvis message');
    return null;
  }
}

export async function editJarvisMessage(
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  if (!jarvisApi) return;
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    await jarvisApi.editMessageText(numericId, messageId, text, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    logger.debug(
      { chatId, messageId, err },
      'editJarvisMessage failed (ignored)',
    );
  }
}

export async function deleteJarvisMessage(
  chatId: string,
  messageId: number,
): Promise<void> {
  if (!jarvisApi) return;
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    await jarvisApi.deleteMessage(numericId, messageId);
  } catch (err) {
    logger.debug(
      { chatId, messageId, err },
      'deleteJarvisMessage failed (ignored)',
    );
  }
}

export async function pinJarvisMessage(
  chatId: string,
  messageId: number,
): Promise<boolean> {
  if (!jarvisApi) return false;
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    await jarvisApi.pinChatMessage(numericId, messageId, {
      disable_notification: true,
    });
    logger.info({ chatId, messageId }, 'Message pinned');
    return true;
  } catch (err) {
    logger.warn({ chatId, messageId, err }, 'pinJarvisMessage failed');
    return false;
  }
}

export async function unpinJarvisMessage(
  chatId: string,
  messageId: number,
): Promise<void> {
  if (!jarvisApi) return;
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    await jarvisApi.unpinChatMessage(numericId, messageId);
  } catch {
    /* ignore — message may not be pinned */
  }
}

export async function reactToMessage(
  chatId: string,
  messageId: number,
  emoji: string = '👀',
): Promise<void> {
  if (!chatId.startsWith('tg-j:')) return;
  if (!jarvisApi) {
    logger.warn(
      { chatId, messageId, emoji },
      'reactToMessage: jarvisApi not initialized',
    );
    return;
  }
  const numericId = chatId.replace(/^tg-j:/, '');
  try {
    await jarvisApi.setMessageReaction(numericId, messageId, [
      { type: 'emoji', emoji: emoji as any },
    ]);
    logger.debug({ chatId, messageId, emoji }, 'Reacted to message');
  } catch (err) {
    logger.warn({ chatId, messageId, emoji, err }, 'reactToMessage failed');
  }
}

export async function removeReaction(
  chatId: string,
  messageId: number,
): Promise<void> {
  if (!chatId.startsWith('tg-j:') || !jarvisApi) return;
  const numericId = chatId.replace(/^tg-j:/, '');
  try {
    await jarvisApi.setMessageReaction(numericId, messageId, []);
    logger.debug({ chatId, messageId }, 'Reaction removed');
  } catch (err) {
    logger.debug({ chatId, messageId, err }, 'removeReaction failed');
  }
}

export async function sendJarvisVideo(
  chatId: string,
  videoBase64: string,
  caption?: string,
): Promise<void> {
  if (!jarvisApi) {
    logger.warn('Jarvis bot not initialized, cannot send video');
    return;
  }
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    const buffer = Buffer.from(videoBase64, 'base64');
    await jarvisApi.sendVideo(numericId, new InputFile(buffer, 'video.mp4'), {
      caption: caption ?? '',
      supports_streaming: true,
    });
    logger.info(
      { chatId, captionLen: caption?.length ?? 0 },
      'Jarvis video sent',
    );
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Jarvis video');
  }
}

export async function sendJarvisPhoto(
  chatId: string,
  imageBase64: string,
  caption?: string,
): Promise<void> {
  if (!jarvisApi) {
    logger.warn('Jarvis bot not initialized, cannot send photo');
    return;
  }
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    const buffer = Buffer.from(imageBase64, 'base64');
    await jarvisApi.sendPhoto(numericId, new InputFile(buffer, 'image.jpg'), {
      caption: caption ?? '',
    });
    logger.info(
      { chatId, captionLen: caption?.length ?? 0 },
      'Jarvis photo sent',
    );
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send Jarvis photo');
  }
}
