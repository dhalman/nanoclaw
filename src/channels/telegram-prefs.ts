/**
 * Telegram group preferences — reads per-group and per-user settings
 * from the host-side .preferences.json files.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';

export function getGroupPref(groupFolder: string, key: string): unknown {
  try {
    const prefsPath = path.join(GROUPS_DIR, groupFolder, '.preferences.json');
    if (!fs.existsSync(prefsPath)) return undefined;
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    return prefs?.group?.[key];
  } catch {
    return undefined;
  }
}

export function getUserPreferredLanguages(
  groupFolder: string,
  userId: string,
): string[] {
  try {
    const prefsPath = path.join(GROUPS_DIR, groupFolder, '.preferences.json');
    if (!fs.existsSync(prefsPath)) return ['en'];
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    const userLang = prefs?.users?.[userId]?.response_language;
    if (userLang && typeof userLang === 'string') return [userLang];
    const groupLang = prefs?.group?.response_language;
    if (groupLang && typeof groupLang === 'string') return [groupLang];
    return ['en'];
  } catch {
    return ['en'];
  }
}

export function getTranslatorLanguages(groupFolder: string): string[] {
  let raw = getGroupPref(groupFolder, 'translator_languages');
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
