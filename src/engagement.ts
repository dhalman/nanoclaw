import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DISMISS_PATTERN,
  GROUPS_DIR,
  TRIGGER_PATTERN,
} from './config.js';
import { logger } from './logger.js';
import { SenderAllowlistConfig, isTriggerAllowed } from './sender-allowlist.js';
import { NewMessage, RegisteredGroup } from './types.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const INTENT_MODEL = process.env.OLLAMA_MODEL_SECRETARY || 'qwen2.5:3b';

// Fast regex: does the message mention the assistant name at all?
const MENTION_PATTERN = new RegExp(
  `\\b${ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
  'i',
);

/**
 * NLP intent check: is this message directed at the assistant, or just mentioning them?
 */
async function classifyIntent(
  text: string,
): Promise<'engage' | 'observe' | null> {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: INTENT_MODEL,
        messages: [
          {
            role: 'system',
            content: `Is "${ASSISTANT_NAME}" being SPOKEN TO (greetings, questions, requests, commands) or just MENTIONED in passing (talking about them to someone else)? Reply: "directed" or "mention"`,
          },
          { role: 'user', content: text },
        ],
        keep_alive: -1,
        options: { num_ctx: 512, temperature: 0.0, num_predict: 10 },
        stream: false,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { message: { content: string } };
    const answer = data.message.content.trim().toLowerCase();
    if (answer.includes('directed') || answer.includes('direct'))
      return 'engage';
    if (answer.includes('mention')) return 'observe';
    return null;
  } catch {
    return null;
  }
}

// Per-group set of user IDs the assistant is currently engaged with.
const engagedUsers: Record<string, Set<string>> = {};

function getEngaged(chatJid: string): Set<string> {
  if (!engagedUsers[chatJid]) engagedUsers[chatJid] = new Set();
  return engagedUsers[chatJid];
}

/** Read a user preference from the group's preferences file (host-side). */
export function getUserPref(
  groupFolder: string,
  userId: string,
  key: string,
): unknown {
  try {
    const prefsPath = path.join(GROUPS_DIR, groupFolder, '.preferences.json');
    if (!fs.existsSync(prefsPath)) return undefined;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    const userVal = prefs?.users?.[userId]?.[key];
    if (userVal !== undefined) return userVal;
    return prefs?.group?.[key];
  } catch {
    return undefined;
  }
}

export function isEngaged(chatJid: string, userId: string): boolean {
  return engagedUsers[chatJid]?.has(userId) ?? false;
}

export function engageUser(chatJid: string, userId: string): void {
  getEngaged(chatJid).add(userId);
  logger.info({ chatJid, user: userId }, 'Engaged');
}

export function disengageUser(chatJid: string, userId: string): void {
  engagedUsers[chatJid]?.delete(userId);
  logger.info({ chatJid, user: userId }, 'Disengaged');
}

export function disengageAll(chatJid: string): void {
  engagedUsers[chatJid]?.clear();
  logger.info({ chatJid }, 'All disengaged');
}

/**
 * Engagement model:
 * - Direct address (name mention + NLP "directed") → engage, respond
 * - Already engaged → passively listen, respond without name requirement
 * - Dismissal ("bye", "thanks", "done") → disengage, go quiet
 * - After dismissal → only re-engage on direct address or skill-related trigger
 */
export async function checkEngagement(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
  allowlistCfg: SenderAllowlistConfig,
): Promise<boolean> {
  const isMainGroup = group.isMain === true;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  if (!needsTrigger) return true;

  const engaged = getEngaged(chatJid);

  // Dismissal: disengage users who send clear farewell messages
  for (const m of messages) {
    if (
      !m.is_from_me &&
      engaged.has(m.sender) &&
      DISMISS_PATTERN.test(m.content.trim())
    ) {
      engaged.delete(m.sender);
      logger.info({ chatJid, user: m.sender }, 'Disengaged (dismissal)');
    }
  }

  // Already-engaged users: respond to questions/commands, ignore casual chatter
  const engagedMessages = messages.filter(
    (m) => !m.is_from_me && engaged.has(m.sender),
  );

  // Owner triggers (is_from_me) always work via regex
  const ownerTriggers = messages.filter(
    (m) => m.is_from_me && TRIGGER_PATTERN.test(m.content.trim()),
  );

  // New triggers: mention check → NLP intent (only for non-engaged users)
  const candidates = messages.filter(
    (m) =>
      !m.is_from_me &&
      !engaged.has(m.sender) &&
      MENTION_PATTERN.test(m.content.trim()) &&
      isTriggerAllowed(chatJid, m.sender, allowlistCfg),
  );

  const triggerMessages: NewMessage[] = [...ownerTriggers];

  if (candidates.length > 0) {
    const intents = await Promise.all(
      candidates.map(async (m) => {
        const intent = await classifyIntent(m.content.trim());
        return { message: m, intent };
      }),
    );
    for (const { message, intent } of intents) {
      if (intent === 'engage') {
        triggerMessages.push(message);
      } else if (intent === null) {
        // NLP failed — fall back to regex
        if (TRIGGER_PATTERN.test(message.content.trim())) {
          triggerMessages.push(message);
        }
      }
    }
  }

  // Engage new users
  for (const m of triggerMessages) {
    if (m.sender && !engaged.has(m.sender)) {
      engaged.add(m.sender);
      logger.info({ chatJid, user: m.sender }, 'Engaged');
    }
  }

  if (triggerMessages.length === 0 && engagedMessages.length === 0)
    return false;

  return true;
}
