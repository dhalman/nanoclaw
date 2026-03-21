import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}

/**
 * Strip reasoning block from response text.
 * Returns { text: stripped response, reasoning: extracted reasoning or null }.
 */
export function stripReasoning(text: string): {
  text: string;
  reasoning: string | null;
} {
  const match = text.match(/💭\s*\*Reasoning:\*\n([\s\S]+?)(?:\n\n(?=\S)|$)/);
  if (!match) return { text, reasoning: null };
  const reasoning = match[1].trim();
  const stripped = text
    .replace(/💭\s*\*Reasoning:\*\n[\s\S]+?(?:\n\n(?=\S)|$)/, '')
    .trim();
  return { text: stripped, reasoning: reasoning || null };
}

/** Is this a group chat JID? (negative Telegram supergroup IDs or WhatsApp group suffix) */
export function isGroupChatJid(chatJid: string): boolean {
  return /^tg-j:-/.test(chatJid) || chatJid.includes('@g.us');
}
