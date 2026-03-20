import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DISMISS_PATTERN, GROUPS_DIR, TRIGGER_PATTERN } from './config.js';
import { logger } from './logger.js';
import { SenderAllowlistConfig, isTriggerAllowed } from './sender-allowlist.js';
import { NewMessage, RegisteredGroup } from './types.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const INTENT_MODEL = process.env.OLLAMA_MODEL_SECRETARY || 'qwen2.5:3b';

// Fast regex: does the message mention the assistant name at all?
const MENTION_PATTERN = new RegExp(`\\b${ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

/**
 * NLP intent check: is this message directed at the assistant, or just mentioning them?
 * Returns 'engage' (directed at assistant), 'observe' (mentioned but not directed), or null (error/timeout).
 */
async function classifyIntent(text: string): Promise<'engage' | 'observe' | null> {
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: INTENT_MODEL,
        messages: [
          { role: 'system', content: `Is this message directed AT ${ASSISTANT_NAME} (asking/telling them something), or just MENTIONING ${ASSISTANT_NAME} in passing? Reply with exactly one word: "directed" or "mention"` },
          { role: 'user', content: text },
        ],
        keep_alive: -1,
        options: { num_ctx: 512, temperature: 0.0, num_predict: 10 },
        stream: false,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { message: { content: string } };
    const answer = data.message.content.trim().toLowerCase();
    if (answer.includes('directed') || answer.includes('direct')) return 'engage';
    if (answer.includes('mention')) return 'observe';
    return null;
  } catch {
    return null;
  }
}

// Per-group set of user IDs the assistant is currently engaged with.
// A user becomes engaged when they trigger by name.
// Disengaged via <disengage:userId/> tag or host-side dismissal pattern.
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
  logger.info({ chatJid, user: userId }, 'Engaged mode: user on');
}

export function disengageUser(chatJid: string, userId: string): void {
  engagedUsers[chatJid]?.delete(userId);
  logger.info({ chatJid, user: userId }, 'Engaged mode: user disengaged');
}

export function disengageAll(chatJid: string): void {
  engagedUsers[chatJid]?.clear();
  logger.info({ chatJid }, 'Engaged mode: all users disengaged');
}

/**
 * Check engagement state for a group's messages and return whether the
 * assistant should process them. Handles trigger detection, per-user
 * engagement mode preferences, and host-side dismissal — all in one place.
 *
 * Returns true if messages should be processed, false to skip.
 * Side effect: updates engaged user state (engage new triggers, dismiss).
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

  // Host-side dismissal: disengage users who send clear farewell messages
  for (const m of messages) {
    if (
      !m.is_from_me &&
      engaged.has(m.sender) &&
      DISMISS_PATTERN.test(m.content.trim())
    ) {
      engaged.delete(m.sender);
      logger.info(
        { chatJid, user: m.sender },
        'Engaged mode: user dismissed (host-side)',
      );
    }
  }

  // Detect messages from already-engaged users, respecting per-user mode
  const engagedMessages = messages.filter((m) => {
    if (m.is_from_me || !engaged.has(m.sender)) return false;
    const userEngMode = getUserPref(group.folder, m.sender, 'engagement_mode');
    if (userEngMode === 'per_message') return false;
    return true;
  });

  // Two-stage trigger detection:
  // Stage 1 (regex, sub-ms): does the message mention the assistant name?
  // Stage 2 (NLP, ~300ms): is it directed AT the assistant, or just mentioning them?
  const candidates = messages.filter(
    (m) =>
      !m.is_from_me &&
      MENTION_PATTERN.test(m.content.trim()) &&
      isTriggerAllowed(chatJid, m.sender, allowlistCfg),
  );

  // Also accept is_from_me triggers via the stricter regex (owner can always trigger)
  const ownerTriggers = messages.filter(
    (m) => m.is_from_me && TRIGGER_PATTERN.test(m.content.trim()),
  );

  const triggerMessages: NewMessage[] = [...ownerTriggers];

  // Run NLP intent classification on candidates (parallel)
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
        logger.info(
          { chatJid, user: message.sender, intent: 'engage' },
          'NLP trigger: directed at assistant',
        );
      } else if (intent === 'observe') {
        logger.debug(
          { chatJid, user: message.sender, intent: 'observe' },
          'NLP trigger: mention only, not engaging',
        );
      } else {
        // NLP failed/timed out — fall back to regex
        if (TRIGGER_PATTERN.test(message.content.trim())) {
          triggerMessages.push(message);
          logger.info(
            { chatJid, user: message.sender, intent: 'regex-fallback' },
            'NLP timeout, regex fallback triggered',
          );
        }
      }
    }
  }

  if (triggerMessages.length === 0 && engagedMessages.length === 0)
    return false;

  // Engage any new users who triggered
  for (const m of triggerMessages) {
    if (m.sender && !engaged.has(m.sender)) {
      engaged.add(m.sender);
      logger.info({ chatJid, user: m.sender }, 'Engaged mode: user on');
    }
  }

  return true;
}
