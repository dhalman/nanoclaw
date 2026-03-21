/**
 * Jarvis bot — the primary Telegram bot that polls for inbound messages,
 * handles text/photo/video/voice, reactions, translations, and feedback.
 * Includes auto-restart polling and 60s watchdog.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import https from 'https';
import { spawn, ChildProcess } from 'child_process';
import { Bot, webhookCallback } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { getLanguageName, translateToMultiple } from '../translation.js';
import { setJarvisApi, sendJarvisMessage } from './telegram-api.js';
import {
  getTranslatorLanguages,
  getUserPreferredLanguages,
} from './telegram-prefs.js';

import type { TelegramChannelOpts } from './telegram.js';

let jarvisBot: Bot | null = null;

export function getJarvisBot(): Bot | null {
  return jarvisBot;
}

export async function initJarvisBot(
  token: string,
  opts: TelegramChannelOpts,
): Promise<void> {
  try {
    jarvisBot = new Bot(token, {
      client: { baseFetchConfig: { agent: https.globalAgent, compress: true } },
    });
    setJarvisApi(jarvisBot.api);

    jarvisBot.command('chatid', (ctx) => {
      ctx.reply(`Chat ID: \`tg-j:${ctx.chat.id}\``, {
        parse_mode: 'Markdown',
      });
    });

    // --- Text messages ---
    jarvisBot.on('message:text', async (ctx) => {
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

      // On-demand translation
      if (handleTranslationCommand(ctx, chatJid, group, text, token)) return;

      // Replying to Jarvis = direct interaction
      const isReplyToJarvis =
        ctx.message.reply_to_message &&
        ctx.message.reply_to_message.from?.id === jarvisBot?.botInfo?.id;
      const messageContent =
        isReplyToJarvis && !text.includes(ASSISTANT_NAME)
          ? `${ASSISTANT_NAME}, ${text}`
          : text;

      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: messageContent,
        timestamp,
        is_from_me: false,
      });

      // Auto-translate group messages
      if (isGroup) {
        autoTranslateMessage(chatJid, group, text, ctx.message.message_id);
      }

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Jarvis message received',
      );
    });

    // --- Video messages ---
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
      const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
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
      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: caption ? `[Video] ${caption}` : '[Video]',
        timestamp,
        is_from_me: false,
        videoBase64,
      });

      logger.info(
        { chatJid, sender: senderName, hasVideo: !!videoBase64 },
        'Jarvis video received',
      );
    });

    // --- Photo messages ---
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

      const photos = ctx.message.photo;
      const images: string[] = [];
      try {
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
      opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content: caption ? `[Photo] ${caption}` : '[Photo]',
        timestamp,
        is_from_me: false,
        images: images.length > 0 ? images : undefined,
      });

      logger.info(
        { chatJid, sender: senderName, hasImage: images.length > 0 },
        'Jarvis photo received',
      );
    });

    // --- Voice messages ---
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

      const isReplyToOther =
        ctx.message.reply_to_message &&
        ctx.message.reply_to_message.from?.id !== jarvisBot?.botInfo?.id;
      const triggerContent =
        isReplyToOther || content.includes(ASSISTANT_NAME)
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

    // --- New members ---
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

    // --- Reactions ---
    jarvisBot.on('message_reaction', async (ctx) => {
      logger.info(
        { chatId: ctx.chat.id, messageId: ctx.messageReaction?.message_id },
        'Reaction event received',
      );
      await handleReaction(ctx, opts);
    });

    const me = await jarvisBot.api.getMe();
    logger.info({ username: me.username, id: me.id }, 'Jarvis bot initialized');

    // Try webhook mode via Cloudflare quick tunnel, fall back to polling
    const WEBHOOK_PORT = parseInt(process.env.JARVIS_WEBHOOK_PORT || '8443', 10);
    const ALLOWED_UPDATES: ('message' | 'edited_message' | 'message_reaction' | 'chat_member')[] = [
      'message', 'edited_message', 'message_reaction', 'chat_member',
    ];

    // Start tunnel in background — don't block bot startup
    // Use polling immediately, then upgrade to webhook once tunnel DNS propagates
    await jarvisBot.api.deleteWebhook().catch(() => {});

    const startPolling = () => {
      jarvisBot!
        .start({ allowed_updates: ALLOWED_UPDATES })
        .then(() => {
          logger.warn('Jarvis polling ended, restarting in 5s');
          setTimeout(startPolling, 5000);
        })
        .catch((err) => {
          logger.error({ err }, 'Jarvis polling error, restarting in 5s');
          setTimeout(startPolling, 5000);
        });
    };
    startPolling();
    logger.info('Jarvis bot started (polling mode)');

    // Watchdog for polling
    setInterval(async () => {
      if (!jarvisBot) return;
      try {
        await jarvisBot.api.getMe();
      } catch (err) {
        logger.error({ err }, 'Jarvis watchdog failed, restarting polling');
        try { await jarvisBot?.stop(); } catch { /* ignore */ }
        startPolling();
      }
    }, 60_000);

    // Webhook upgrade available when a stable Cloudflare tunnel domain is configured
    // Quick tunnels (*.trycloudflare.com) don't work — Telegram can't resolve ephemeral DNS
    const webhookDomain = process.env.JARVIS_WEBHOOK_DOMAIN;
    if (webhookDomain) {
      upgradeToWebhook(jarvisBot, WEBHOOK_PORT, ALLOWED_UPDATES, webhookDomain).catch((err) => {
        logger.debug({ err }, 'Webhook upgrade failed (staying on polling)');
      });
    }
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Jarvis bot');
    setJarvisApi(null);
    jarvisBot = null;
  }
}

let tunnelProcess: ChildProcess | null = null;

/**
 * Upgrade from polling to webhook using a stable Cloudflare tunnel domain.
 * Requires JARVIS_WEBHOOK_DOMAIN env var (e.g., jarvis.yourdomain.com).
 * Quick tunnels (*.trycloudflare.com) don't work — Telegram can't resolve ephemeral DNS.
 */
async function upgradeToWebhook(
  bot: Bot,
  port: number,
  allowedUpdates: string[],
  domain: string,
): Promise<void> {
  const webhookUrl = `https://${domain}/webhook`;

  // Start the webhook HTTP server
  const handleUpdate = webhookCallback(bot, 'http');
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/webhook') {
      try {
        await handleUpdate(req, res);
      } catch (err) {
        logger.error({ err }, 'Webhook handler error');
        res.writeHead(500);
        res.end();
      }
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  });
  server.listen(port, () => {
    logger.info({ port }, 'Webhook server listening');
  });

  // Stop polling and register webhook
  try {
    await bot.stop();
  } catch { /* may not be running */ }

  await bot.api.setWebhook(webhookUrl, {
    allowed_updates: allowedUpdates as any,
  });
  logger.info({ webhookUrl }, 'Upgraded to webhook mode');
}

async function startCloudflaredTunnel(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const cloudflared = process.env.CLOUDFLARED_BIN || '/opt/homebrew/bin/cloudflared';
    try {
      fs.accessSync(cloudflared, fs.constants.X_OK);
    } catch {
      logger.warn({ cloudflared }, 'cloudflared not found, skipping tunnel');
      resolve(null);
      return;
    }

    tunnelProcess = spawn(cloudflared, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.error('Cloudflared tunnel URL not found within 15s');
        resolve(null);
      }
    }, 15_000);

    // Cloudflared prints the tunnel URL to stderr
    tunnelProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString();
      // Look for the trycloudflare.com URL
      const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        logger.info({ tunnelUrl: match[1] }, 'Cloudflare tunnel established');
        resolve(match[1]);
      }
    });

    tunnelProcess.on('exit', (code) => {
      logger.warn({ code }, 'Cloudflared tunnel exited');
      tunnelProcess = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });

    tunnelProcess.on('error', (err) => {
      logger.error({ err }, 'Cloudflared tunnel spawn error');
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

// Clean up tunnel on process exit
process.on('exit', () => {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
  }
});

// --- Internal helpers ---

function handleTranslationCommand(
  ctx: any,
  chatJid: string,
  group: any,
  text: string,
  _token: string,
): boolean {
  const TRANSLATE_CMD = /^\s*(?:translate|translation|🌐)\s*$/i;
  const TRANSLATE_DISSATISFIED =
    /\b(?:bad|wrong|incorrect|not (?:right|correct|accurate)|inaccurate|poor|terrible|awful|horrible|mistranslat|not quite|better translation|translate (?:again|better|properly|correctly)|re-?translate|fix (?:the )?translat)\b/i;
  const isTranslateRequest = TRANSLATE_CMD.test(text);
  const isTranslateComplaint =
    TRANSLATE_DISSATISFIED.test(text) &&
    ctx.message.reply_to_message?.text?.includes('🌐');

  if (!isTranslateRequest && !isTranslateComplaint) return false;

  if (!ctx.message.reply_to_message) {
    if (isTranslateRequest) {
      sendJarvisMessage(
        chatJid,
        '_Reply to a message with "translate" to translate it._',
      ).catch(() => {});
    }
    return true;
  }

  let sourceText: string | undefined;
  let replyTarget = ctx.message.reply_to_message.message_id;

  if (isTranslateComplaint) {
    const origReply = (ctx.message.reply_to_message as any)?.reply_to_message;
    sourceText = origReply?.text || origReply?.caption;
    if (origReply?.message_id) replyTarget = origReply.message_id;
    if (!sourceText) {
      const transText = ctx.message.reply_to_message.text || '';
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
      return true;
    }
    const useHighQuality = isTranslateComplaint;
    const model = useHighQuality ? 'qwen3.5:35b' : undefined;
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
  return true;
}

function autoTranslateMessage(
  chatJid: string,
  group: any,
  text: string,
  messageId: number,
): void {
  const isTranslationOutput =
    /^_?🌐\s*\[/.test(text) || /^_?🎙\s/.test(text) || /^_?💬\s/.test(text);
  const isNojar = /\(nojar\)/i.test(text);
  if (isTranslationOutput || isNojar) return;

  const targetLangs = getTranslatorLanguages(group.folder);
  const onlyEnglish = targetLangs.length === 1 && targetLangs[0] === 'en';
  const isLatinText =
    /^[\x00-\x7F\u00C0-\u024F\u1E00-\u1EFF\s\p{P}\p{S}\d]+$/u.test(text);
  if (
    targetLangs.length > 0 &&
    text.length > 2 &&
    !(onlyEnglish && isLatinText)
  ) {
    translateToMultiple(text, 'auto', targetLangs)
      .then((translations) => {
        if (translations.length > 0) {
          const echo = translations
            .map((t) => `_🌐 [${t.targetName}] ${t.text}_`)
            .join('\n\n');
          sendJarvisMessage(chatJid, echo, messageId).catch(() => {});
        }
      })
      .catch(() => {});
  }
}

async function handleReaction(
  ctx: any,
  opts: TelegramChannelOpts,
): Promise<void> {
  const chatJid = `tg-j:${ctx.chat.id}`;
  const group = opts.registeredGroups()[chatJid];
  if (!group) return;

  const reactions = ctx.messageReaction?.new_reaction ?? [];
  const emojiReactions = reactions
    .filter((r: any) => r.type === 'emoji')
    .map((r: any) => r.emoji as string);
  const messageId = ctx.messageReaction?.message_id;

  // Learn emoji style + sentiment analysis
  if (messageId && emojiReactions.length > 0) {
    const userId = ctx.messageReaction?.user?.id?.toString() || '';
    if (userId) {
      const { learnUserEmoji } = await import('../engagement.js');
      for (const e of emojiReactions) learnUserEmoji(chatJid, userId, e);
    }
    analyzeSentiment(chatJid, messageId, emojiReactions);
  }

  // Thumbs-down on Jarvis message — inject feedback
  if (emojiReactions.includes('👎') && messageId) {
    await handleNegativeFeedback(chatJid, group, messageId, ctx);
  }

  // Eyes emoji = translate trigger
  if (emojiReactions.includes('👀') && messageId) {
    await handleTranslateReaction(chatJid, group, messageId);
  }
}

function analyzeSentiment(
  chatJid: string,
  messageId: number,
  emojiReactions: string[],
): void {
  (async () => {
    try {
      const { getMessageById } = await import('../db.js');
      const msg = getMessageById?.(chatJid, messageId.toString());
      const msgText = msg?.content?.slice(0, 200) || '(unknown message)';
      const emojis = emojiReactions.join(' ');

      const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
      const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemma3:4b',
          messages: [
            {
              role: 'user',
              content: `A user reacted with ${emojis} to this message: "${msgText}"\n\nWhat does this reaction mean in context? Reply with JSON only:\n{"sentiment":"positive|negative|neutral|mixed","meaning":"one sentence","actionable":true|false}`,
            },
          ],
          keep_alive: -1,
          options: { num_ctx: 512, temperature: 0, num_predict: 60 },
          stream: false,
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { message: { content: string } };
        const raw = data.message.content
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/i, '');
        try {
          const analysis = JSON.parse(raw.match(/\{[^{}]*\}/)?.[0] || raw);
          logger.info(
            {
              chatJid,
              messageId,
              emojis: emojiReactions.join(' '),
              sentiment: analysis.sentiment,
              meaning: analysis.meaning,
              actionable: analysis.actionable,
            },
            'Reaction sentiment analyzed',
          );
        } catch {
          logger.info(
            { chatJid, messageId, emojis: emojiReactions.join(' ') },
            'Reaction logged (analysis parse failed)',
          );
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Sentiment analysis failed (background)');
    }
  })();
}

async function handleNegativeFeedback(
  chatJid: string,
  group: any,
  messageId: number,
  ctx: any,
): Promise<void> {
  const { getMessageById, storeMessage } = await import('../db.js');
  const { engageUser } = await import('../engagement.js');
  const msg = getMessageById?.(chatJid, messageId.toString());
  if (!msg?.is_from_me) return;

  const userId = ctx.messageReaction?.user?.id?.toString() || '';
  const userName = ctx.messageReaction?.user?.first_name || 'User';
  const excerpt = (msg.content || '').slice(0, 200);

  storeMessage({
    id: `feedback-${Date.now()}`,
    chat_jid: chatJid,
    sender: userId,
    sender_name: userName,
    content: `[${userName} reacted 👎 to your message: "${excerpt}${msg.content.length > 200 ? '...' : ''}"]`,
    timestamp: new Date().toISOString(),
  });

  if (userId) engageUser(chatJid, userId);

  try {
    const { GROUPS_DIR } = await import('../config.js');
    const perfLogPath = path.join(GROUPS_DIR, group.folder, '.perf-log.jsonl');
    const entry = JSON.stringify({
      type: 'feedback',
      feedbackType: 'negative_reaction',
      timestamp: new Date().toISOString(),
      userId,
      feedbackContext: excerpt.slice(0, 200),
      chatJid,
    });
    fs.appendFileSync(perfLogPath, entry + '\n');
  } catch {
    /* best effort */
  }
  logger.info(
    { chatJid, messageId, userId },
    'Negative reaction on Jarvis message — feedback injected',
  );
}

async function handleTranslateReaction(
  chatJid: string,
  group: any,
  messageId: number,
): Promise<void> {
  try {
    const { getMessageById } = await import('../db.js');
    const msg = getMessageById?.(chatJid, messageId.toString());
    if (!msg?.content) return;

    const targetLangs = getTranslatorLanguages(group.folder);
    if (targetLangs.length === 0) return;

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
    logger.debug({ chatJid, messageId, err }, 'Reaction translation failed');
  }
}
