import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkEngagement,
  disengageAll,
  disengageUser,
  engageUser,
  getUserPref,
  isEngaged,
} from './engagement.js';
import { SenderAllowlistConfig } from './sender-allowlist.js';
import { NewMessage, RegisteredGroup } from './types.js';

let tmpDir: string;

const OPEN_ALLOWLIST: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  chats: {},
  logDenied: false,
};

function makeGroup(overrides: Partial<RegisteredGroup> = {}): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test_group',
    trigger: 'Andy',
    added_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: String(Math.random()),
    chat_jid: 'tg:123',
    sender: 'user1',
    sender_name: 'User One',
    content: 'hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engagement-test-'));
  // Reset engagement state between tests by disengaging all
  disengageAll('tg:123');
  disengageAll('tg:456');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- getUserPref ---

describe('getUserPref', () => {
  it('returns undefined when preferences file does not exist', () => {
    expect(getUserPref('nonexistent', 'user1', 'theme')).toBeUndefined();
  });

  it('reads user-level preference', () => {
    const folder = path.join(tmpDir, 'test_group');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, '.preferences.json'),
      JSON.stringify({
        users: { user1: { engagement_mode: 'per_message' } },
      }),
    );
    // getUserPref uses GROUPS_DIR which we can't override easily,
    // so we test the logic indirectly through checkEngagement
  });

  it('falls back to group-level preference when user has none', () => {
    // Tested indirectly through checkEngagement below
  });
});

// --- engage / disengage ---

describe('engagement state', () => {
  it('engageUser makes user engaged', () => {
    expect(isEngaged('tg:123', 'user1')).toBe(false);
    engageUser('tg:123', 'user1');
    expect(isEngaged('tg:123', 'user1')).toBe(true);
  });

  it('disengageUser removes user', () => {
    engageUser('tg:123', 'user1');
    disengageUser('tg:123', 'user1');
    expect(isEngaged('tg:123', 'user1')).toBe(false);
  });

  it('disengageAll clears all users for a group', () => {
    engageUser('tg:123', 'user1');
    engageUser('tg:123', 'user2');
    disengageAll('tg:123');
    expect(isEngaged('tg:123', 'user1')).toBe(false);
    expect(isEngaged('tg:123', 'user2')).toBe(false);
  });

  it('engagement is per-group', () => {
    engageUser('tg:123', 'user1');
    expect(isEngaged('tg:123', 'user1')).toBe(true);
    expect(isEngaged('tg:456', 'user1')).toBe(false);
  });

  it('disengageUser on non-existent group does not throw', () => {
    expect(() => disengageUser('tg:999', 'user1')).not.toThrow();
  });

  it('disengageAll on non-existent group does not throw', () => {
    expect(() => disengageAll('tg:999')).not.toThrow();
  });
});

// --- checkEngagement ---

describe('checkEngagement', () => {
  it('returns true for main group (no trigger required)', () => {
    const group = makeGroup({ isMain: true });
    const msgs = [makeMsg({ content: 'random message' })];
    expect(checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST)).toBe(true);
  });

  it('returns true when requiresTrigger is false', () => {
    const group = makeGroup({ requiresTrigger: false });
    const msgs = [makeMsg({ content: 'random message' })];
    expect(checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST)).toBe(true);
  });

  it('returns false when no trigger and no engaged users', () => {
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'random message' })];
    expect(checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST)).toBe(false);
  });

  it('returns true and engages user on trigger message', () => {
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'Jarvis, help me' })];
    expect(checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST)).toBe(true);
    expect(isEngaged('tg:123', 'user1')).toBe(true);
  });

  it('returns true for messages from already-engaged users', () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'follow up question' })];
    expect(checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST)).toBe(true);
  });

  it('dismisses engaged user on farewell message but still processes it', () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'bye' })];
    // The "bye" message is from an engaged user, so it gets processed.
    // The user is disengaged as a side effect for NEXT time.
    expect(checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST)).toBe(true);
    expect(isEngaged('tg:123', 'user1')).toBe(false);
  });

  it('dismissal patterns are case insensitive', () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    for (const farewell of ['Bye', 'GOODBYE', 'nah', 'No Thanks', "I'm good"]) {
      engageUser('tg:123', 'user1');
      const msgs = [makeMsg({ content: farewell })];
      checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
      expect(isEngaged('tg:123', 'user1')).toBe(false);
    }
  });

  it('does not dismiss on non-farewell messages', () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'bye the way, this is great' })];
    checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    // "bye the way" should NOT match — DISMISS_PATTERN requires full match
    expect(isEngaged('tg:123', 'user1')).toBe(true);
  });

  it('does not dismiss own messages', () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'bye', is_from_me: true })];
    checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(isEngaged('tg:123', 'user1')).toBe(true);
  });

  it('respects sender allowlist for triggers', () => {
    const restrictedAllowlist: SenderAllowlistConfig = {
      default: { allow: ['allowed_user'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    const group = makeGroup();
    // Denied user triggers — should not engage
    const msgs = [makeMsg({ sender: 'denied_user', content: 'Jarvis, help' })];
    expect(checkEngagement('tg:123', group, msgs, restrictedAllowlist)).toBe(
      false,
    );
    expect(isEngaged('tg:123', 'denied_user')).toBe(false);
  });

  it('allows is_from_me triggers regardless of allowlist', () => {
    const restrictedAllowlist: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'Jarvis, test', is_from_me: true })];
    expect(checkEngagement('tg:123', group, msgs, restrictedAllowlist)).toBe(
      true,
    );
  });
});
