import fs from 'fs';
import path from 'path';

import { DISMISS_PATTERN, GROUPS_DIR, TRIGGER_PATTERN } from './config.js';
import { logger } from './logger.js';
import { SenderAllowlistConfig, isTriggerAllowed } from './sender-allowlist.js';
import { NewMessage, RegisteredGroup } from './types.js';

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
export function checkEngagement(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
  allowlistCfg: SenderAllowlistConfig,
): boolean {
  const isMainGroup = group.isMain === true;
  const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
  if (!needsTrigger) return true;

  const engaged = getEngaged(chatJid);

  // Detect trigger messages (direct address by name)
  const triggerMessages = messages.filter(
    (m) =>
      TRIGGER_PATTERN.test(m.content.trim()) &&
      (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
  );

  // Detect messages from already-engaged users, respecting per-user mode
  const engagedMessages = messages.filter((m) => {
    if (m.is_from_me || !engaged.has(m.sender)) return false;
    const userEngMode = getUserPref(group.folder, m.sender, 'engagement_mode');
    if (userEngMode === 'per_message') return false;
    return true;
  });

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

  if (triggerMessages.length === 0 && engagedMessages.length === 0)
    return false;

  // Engage any new users who triggered by name
  for (const m of triggerMessages) {
    if (m.sender && !engaged.has(m.sender)) {
      engaged.add(m.sender);
      logger.info({ chatJid, user: m.sender }, 'Engaged mode: user on');
    }
  }

  return true;
}
