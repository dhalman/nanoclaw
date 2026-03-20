import fs from 'fs';
import path from 'path';
import https from 'https';
import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { getLanguageName, translateToMultiple } from '../translation.js';

/** Read a group preference from the host-side preferences file. */
function getGroupPref(groupFolder: string, key: string): unknown {
  try {
    const prefsPath = path.join(GROUPS_DIR, groupFolder, '.preferences.json');
    if (!fs.existsSync(prefsPath)) return undefined;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    return prefs?.group?.[key];
  } catch {
    return undefined;
  }
}

/** Get a user's preferred language from group preferences. */
function getUserPreferredLanguages(
  groupFolder: string,
  userId: string,
): string[] {
  try {
    const prefsPath = path.join(GROUPS_DIR, groupFolder, '.preferences.json');
    if (!fs.existsSync(prefsPath)) return ['en'];
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    // Check user override first, then group default
    const userLang = prefs?.users?.[userId]?.response_language;
    if (userLang && typeof userLang === 'string') return [userLang];
    const groupLang = prefs?.group?.response_language;
    if (groupLang && typeof groupLang === 'string') return [groupLang];
    return ['en'];
  } catch {
    return ['en'];
  }
}

/** Get translator languages for a group — only what's explicitly subscribed. */
function getTranslatorLanguages(groupFolder: string): string[] {
  let raw = getGroupPref(groupFolder, 'translator_languages');
  // Handle double-serialized values (stored as string instead of array)
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw)
    ? raw.filter((l): l is string => typeof l === 'string')
    : [];
}
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  isUserEngaged?: (chatJid: string, userId: string) => boolean;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
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
    // Fallback: send as plain text if Markdown parsing fails
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

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
// Maps "{groupFolder}:{senderName}" → pool Api index for stable assignment
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    logger.warn('No pool bots available, falling back to main bot');
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info(
        { sender, groupFolder, poolIndex: idx },
        'Assigned and renamed pool bot',
      );
    } catch (err) {
      logger.warn(
        { sender, err },
        'Failed to rename pool bot (sending anyway)',
      );
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg(-j)?:/, '');
    const MAX_LENGTH = 4096;
    if (text.length <= MAX_LENGTH) {
      await api.sendMessage(numericId, text);
    } else {
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        await api.sendMessage(numericId, text.slice(i, i + MAX_LENGTH));
      }
    }
    logger.info(
      { chatId, sender, poolIndex: idx, length: text.length },
      'Pool message sent',
    );
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

// Dedicated bot for Jarvis: polls for inbound messages AND sends responses
let jarvisApi: Api | null = null;
let jarvisBot: Bot | null = null;

export async function initJarvisBot(
  token: string,
  opts: TelegramChannelOpts,
): Promise<void> {
  try {
    jarvisBot = new Bot(token, {
      client: { baseFetchConfig: { agent: https.globalAgent, compress: true } },
    });
    jarvisApi = jarvisBot.api;

    jarvisBot.command('chatid', (ctx) => {
      ctx.reply(`Chat ID: \`tg-j:${ctx.chat.id}\``, { parse_mode: 'Markdown' });
    });

    jarvisBot.on('message:text', async (ctx) => {
      // Use tg-j: prefix so Jarvis DMs don't conflict with Andy's tg: JIDs
      const chatJid = `tg-j:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const chatName = isGroup
        ? (ctx.chat as any).title || chatJid
        : senderName;

      opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      const group = opts.registeredGroups()[chatJid];
      if (!group) return;

      const text = ctx.message.text;

      // On-demand or improved translation: reply to any message with "translate",
      // or reply to a translation with dissatisfaction to get a 35B re-translation.
      const TRANSLATE_CMD = /^\s*(?:translate|translation|🌐)\s*$/i;
      const TRANSLATE_DISSATISFIED =
        /\b(?:bad|wrong|incorrect|not (?:right|correct|accurate)|inaccurate|poor|terrible|awful|horrible|mistranslat|not quite|better translation|translate (?:again|better|properly|correctly)|re-?translate|fix (?:the )?translat)\b/i;
      const isTranslateRequest = TRANSLATE_CMD.test(text);
      const isTranslateComplaint =
        TRANSLATE_DISSATISFIED.test(text) &&
        ctx.message.reply_to_message?.text?.includes('🌐');
      if (isTranslateRequest || isTranslateComplaint) {
        // Works in groups and DMs, with or without a reply
        if (!ctx.message.reply_to_message) {
          // No reply — translate the command itself? No, just skip.
          // User needs to reply to a message to translate it.
          if (isTranslateRequest) {
            sendJarvisMessage(
              chatJid,
              '_Reply to a message with "translate" to translate it._',
            ).catch(() => {});
            return;
          }
        }
      }
      if (
        ctx.message.reply_to_message &&
        (isTranslateRequest || isTranslateComplaint)
      ) {
        // For complaints about translations, get the original message being
        // replied to (the translation's reply_to). For direct "translate", use the reply target.
        let sourceText: string | undefined;
        let replyTarget = ctx.message.reply_to_message!.message_id;

        if (isTranslateComplaint) {
          // The replied-to message is a translation — find the original it was replying to
          const origReply = (ctx.message.reply_to_message as any)
            ?.reply_to_message;
          sourceText = origReply?.text || origReply?.caption;
          if (origReply?.message_id) replyTarget = origReply.message_id;
          // Fall back to stripping 🌐 lines from the translation message itself
          if (!sourceText) {
            const transText = ctx.message.reply_to_message.text || '';
            // Not recoverable — just re-translate the translation message
            sourceText = transText.replace(/_?🌐\s*\[[^\]]*\]\s*/g, '').trim();
          }
        } else {
          sourceText =
            ctx.message.reply_to_message.text ||
            (ctx.message.reply_to_message as any).caption;
        }

        if (sourceText) {
          const targetLangs = getTranslatorLanguages(group.folder);
          if (targetLangs.length === 0) {
            sendJarvisMessage(
              chatJid,
              '_No languages registered. Tell me which language to translate to, e.g. "Jarvis, translate this to Spanish"_',
            ).catch(() => {});
            return;
          }
          // Use 35B for complaints/re-translations, 3B for standard requests
          const useHighQuality = isTranslateComplaint;
          const model = useHighQuality ? 'qwen3.5:35b' : undefined;
          {
            translateToMultiple(sourceText, 'auto', targetLangs, model)
              .then((translations) => {
                if (translations.length > 0) {
                  const prefix = useHighQuality ? '_🔄 improved:_\n' : '';
                  const echo =
                    prefix +
                    translations
                      .map((t) => `_🌐 [${t.targetName}] ${t.text}_`)
                      .join('\n\n');
                  sendJarvisMessage(chatJid, echo, replyTarget).catch(() => {});
                }
              })
              .catch(() => {});
          }
        }
        // Don't store or process the translate/complaint command itself
        return;
      }

      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: false,
      });

      // Auto-translate all group messages (skip messages that are already translations)
      const isTranslationOutput =
        /^_?🌐\s*\[/.test(text) || /^_?🎙\s/.test(text) || /^_?💬\s/.test(text);
      if (isGroup && !isTranslationOutput) {
        const targetLangs = getTranslatorLanguages(group.folder);
        if (targetLangs.length > 0 && text.length > 2) {
          translateToMultiple(text, 'auto', targetLangs)
            .then((translations) => {
              if (translations.length > 0) {
                const echo = translations
                  .map((t) => `_🌐 [${t.targetName}] ${t.text}_`)
                  .join('\n\n');
                sendJarvisMessage(chatJid, echo, ctx.message.message_id).catch(
                  () => {},
                );
              }
            })
            .catch(() => {});
        }
      }

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Jarvis message received',
      );
    });

    jarvisBot.on('message:video', async (ctx) => {
      const chatJid = `tg-j:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const chatName = isGroup
        ? (ctx.chat as any).title || chatJid
        : senderName;

      opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);
      const group = opts.registeredGroups()[chatJid];
      if (!group) return;

      const video = ctx.message.video;
      const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // Telegram Bot API limit
      let videoBase64: string | undefined;

      if (video && (!video.file_size || video.file_size <= MAX_VIDEO_BYTES)) {
        try {
          const file = await jarvisBot!.api.getFile(video.file_id);
          if (file.file_path) {
            const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
            const resp = await fetch(url);
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              videoBase64 = buf.toString('base64');
            }
          }
        } catch (err) {
          logger.error({ chatJid, err }, 'Failed to download Jarvis video');
        }
      } else if (video?.file_size && video.file_size > MAX_VIDEO_BYTES) {
        logger.warn(
          { chatJid, size: video.file_size },
          'Jarvis video too large to download (>20MB)',
        );
      }

      const caption = ctx.message.caption || '';
      const content = caption ? `[Video] ${caption}` : '[Video]';

      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        videoBase64,
      });

      logger.info(
        { chatJid, sender: senderName, hasVideo: !!videoBase64 },
        'Jarvis video received',
      );
    });

    jarvisBot.on('message:photo', async (ctx) => {
      const chatJid = `tg-j:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const chatName = isGroup
        ? (ctx.chat as any).title || chatJid
        : senderName;

      opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);

      const group = opts.registeredGroups()[chatJid];
      if (!group) return;

      // Download all photos in the message (Telegram sends multiple resolutions;
      // take the last/highest-res of each unique photo)
      const photos = ctx.message.photo;
      const images: string[] = [];
      try {
        // Telegram groups resolutions as increasing file_size; last = highest res
        const best = photos[photos.length - 1];
        const file = await jarvisBot!.api.getFile(best.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            images.push(buf.toString('base64'));
          }
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to download Jarvis photo');
      }

      const caption = ctx.message.caption || '';
      const content = caption ? `[Photo] ${caption}` : '[Photo]';

      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        images: images.length > 0 ? images : undefined,
      });

      logger.info(
        { chatJid, sender: senderName, hasImage: images.length > 0 },
        'Jarvis photo received',
      );
    });

    jarvisBot.on('message:voice', async (ctx) => {
      const chatJid = `tg-j:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      const chatName = isGroup
        ? (ctx.chat as any).title || chatJid
        : senderName;

      opts.onChatMetadata(chatJid, timestamp, chatName, 'telegram', isGroup);
      const group = opts.registeredGroups()[chatJid];
      if (!group) return;

      let content = '[Voice message]';
      try {
        const file = await jarvisBot!.api.getFile(ctx.message.voice.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const result = await transcribeAudio(buf, 'ogg');
            if (result) {
              content = `[Voice: ${result.text}]`;
              logger.info(
                { chatJid, chars: result.text.length, lang: result.language },
                'Jarvis voice message transcribed',
              );
              // Always translate voice memos: all subscribed languages in groups,
              // user's preferred language in DMs
              const targetLangs = isGroup
                ? getTranslatorLanguages(group.folder)
                : getUserPreferredLanguages(group.folder, sender);
              let echo = `_🎙 [${getLanguageName(result.language)}] "${result.text}"_`;
              const translations = await translateToMultiple(
                result.text,
                result.language,
                targetLangs,
              );
              if (translations.length > 0) {
                for (const t of translations) {
                  echo += `\n\n_🌐 [${t.targetName}] ${t.text}_`;
                }
                content = `[Voice (${getLanguageName(result.language)}): ${result.text}]`;
                for (const t of translations) {
                  content += `\n[${t.targetName}: ${t.text}]`;
                }
              }
              sendJarvisMessage(chatJid, echo, ctx.message.message_id).catch(
                () => {},
              );
            } else {
              content = '[Voice message - transcription unavailable]';
            }
          }
        }
      } catch (err) {
        logger.warn(
          { chatJid, err },
          'Failed to transcribe Jarvis voice message',
        );
      }

      // Voice messages directed at Jarvis: prepend name so engagement triggers.
      // Skip if replying to another user's message (that's member-to-member).
      const isReplyToOther = ctx.message.reply_to_message &&
        ctx.message.reply_to_message.from?.id !== jarvisBot?.botInfo?.id;
      const triggerContent = isReplyToOther || content.includes(ASSISTANT_NAME)
        ? content
        : `${ASSISTANT_NAME}, ${content}`;
      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: triggerContent,
        timestamp,
        is_from_me: false,
      });
    });

    jarvisBot.on('message:new_chat_members', async (ctx) => {
      const chatJid = `tg-j:${ctx.chat.id}`;
      const group = opts.registeredGroups()[chatJid];
      if (!group) return;

      const newMembers = ctx.message.new_chat_members ?? [];
      for (const member of newMembers) {
        if (member.is_bot) continue;
        const name = member.first_name || member.username || 'there';
        const assistantName =
          group.containerConfig?.assistantName || ASSISTANT_NAME;
        sendJarvisMessage(
          chatJid,
          `_Welcome, ${name}! 👋 I'm ${assistantName}. Say my name to start a conversation with me — I'll stay engaged until you dismiss me. Happy to help anytime!_`,
        ).catch(() => {});
        logger.info(
          { chatJid, userId: member.id, name },
          'New member welcomed',
        );
      }
    });

    // 🌐 reaction handler — translate the reacted message on demand
    jarvisBot.on('message_reaction', async (ctx) => {
      const chatJid = `tg-j:${ctx.chat.id}`;
      const group = opts.registeredGroups()[chatJid];
      if (!group) return;

      const reactions = ctx.messageReaction?.new_reaction ?? [];
      // Use 👀 (eyes) as the translate trigger — it's in Telegram's supported emoji list
      // and semantically means "let me see this in my language"
      const hasTranslateEmoji = reactions.some(
        (r) =>
          (r.type === 'emoji' && r.emoji === '👀') || r.type === 'custom_emoji',
      );
      if (!hasTranslateEmoji) return;

      const messageId = ctx.messageReaction?.message_id;
      if (!messageId) return;

      // Look up the message content from DB
      try {
        const { getMessageById } = await import('../db.js');
        const msg = getMessageById?.(chatJid, messageId.toString());
        if (!msg?.content) return;

        const targetLangs = getTranslatorLanguages(group.folder);
        if (targetLangs.length === 0) return;

        // Detect source language via a quick inference, then translate
        const { translateToMultiple, getLanguageName } =
          await import('../translation.js');
        // Use 'auto' detection — translate to all subscribed languages
        const translations = await translateToMultiple(
          msg.content,
          'auto',
          targetLangs,
        );
        if (translations.length > 0) {
          const echo = translations
            .map((t) => `_🌐 [${t.targetName}] ${t.text}_`)
            .join('\n\n');
          sendJarvisMessage(chatJid, echo, messageId).catch(() => {});
        }
      } catch (err) {
        logger.debug(
          { chatJid, messageId, err },
          'Reaction translation failed',
        );
      }
    });

    const me = await jarvisBot.api.getMe();
    logger.info({ username: me.username, id: me.id }, 'Jarvis bot initialized');

    // Start polling in the background (non-blocking)
    jarvisBot
      .start()
      .catch((err) => logger.error({ err }, 'Jarvis bot polling error'));
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Jarvis bot');
    jarvisApi = null;
    jarvisBot = null;
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
    // Message may have been deleted or is too old — ignore
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
): Promise<void> {
  if (!jarvisApi) return;
  const numericId = chatId.replace(/^tg(-j)?:/, '');
  try {
    await jarvisApi.pinChatMessage(numericId, messageId, {
      disable_notification: true,
    });
    logger.info({ chatId, messageId }, 'Message pinned');
  } catch (err) {
    logger.warn({ chatId, messageId, err }, 'pinJarvisMessage failed');
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

/**
 * Send a video via the Jarvis bot.
 * videoBase64: base64-encoded MP4 bytes
 */
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

/**
 * Send a photo via the Jarvis bot.
 * imageBase64: base64-encoded PNG/JPEG bytes
 */
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

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', (ctx) => storeNonText(ctx, '[Photo]'));
    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));
    this.bot.on('message:voice', async (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice message]';
      try {
        const file = await this.bot!.api.getFile(ctx.message.voice.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
          const resp = await fetch(url);
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer());
            const result = await transcribeAudio(buf, 'ogg');
            if (result) {
              content = `[Voice: ${result.text}]`;
              logger.info(
                { chatJid, chars: result.text.length, lang: result.language },
                'Voice message transcribed',
              );
              const targetLangs = isGroup
                ? getTranslatorLanguages(group.folder)
                : getUserPreferredLanguages(
                    group.folder,
                    ctx.from?.id?.toString() || '',
                  );
              let echo = `_🎙 [${getLanguageName(result.language)}] "${result.text}"_`;
              const translations = await translateToMultiple(
                result.text,
                result.language,
                targetLangs,
              );
              if (translations.length > 0) {
                for (const t of translations) {
                  echo += `\n\n_🌐 [${t.targetName}] ${t.text}_`;
                }
                content = `[Voice (${getLanguageName(result.language)}): ${result.text}]`;
                for (const t of translations) {
                  content += `\n[${t.targetName}: ${t.text}]`;
                }
              }
              this.sendMessage(chatJid, echo).catch(() => {});
            } else {
              content = '[Voice message - transcription unavailable]';
            }
          }
        }
      } catch (err) {
        logger.warn({ chatJid, err }, 'Failed to transcribe voice message');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });
    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          // Ensure the bot's display name in Telegram matches ASSISTANT_NAME
          this.bot!.api.setMyName(ASSISTANT_NAME).catch((err: unknown) => {
            logger.warn({ err }, 'Failed to set bot name in Telegram');
          });
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg(-j)?:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:') || jid.startsWith('tg-j:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg(-j)?:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
