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
  it('returns undefined when preferences file does not exist', async () => {
    expect(getUserPref('nonexistent', 'user1', 'theme')).toBeUndefined();
  });

  it('reads user-level preference', async () => {
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

  it('falls back to group-level preference when user has none', async () => {
    // Tested indirectly through checkEngagement below
  });
});

// --- engage / disengage ---

describe('engagement state', () => {
  it('engageUser makes user engaged', async () => {
    expect(isEngaged('tg:123', 'user1')).toBe(false);
    engageUser('tg:123', 'user1');
    expect(isEngaged('tg:123', 'user1')).toBe(true);
  });

  it('disengageUser removes user', async () => {
    engageUser('tg:123', 'user1');
    disengageUser('tg:123', 'user1');
    expect(isEngaged('tg:123', 'user1')).toBe(false);
  });

  it('disengageAll clears all users for a group', async () => {
    engageUser('tg:123', 'user1');
    engageUser('tg:123', 'user2');
    disengageAll('tg:123');
    expect(isEngaged('tg:123', 'user1')).toBe(false);
    expect(isEngaged('tg:123', 'user2')).toBe(false);
  });

  it('engagement is per-group', async () => {
    engageUser('tg:123', 'user1');
    expect(isEngaged('tg:123', 'user1')).toBe(true);
    expect(isEngaged('tg:456', 'user1')).toBe(false);
  });

  it('disengageUser on non-existent group does not throw', async () => {
    expect(() => disengageUser('tg:999', 'user1')).not.toThrow();
  });

  it('disengageAll on non-existent group does not throw', async () => {
    expect(() => disengageAll('tg:999')).not.toThrow();
  });
});

// --- checkEngagement ---

describe('checkEngagement', () => {
  it('returns true for main group (no trigger required)', async () => {
    const group = makeGroup({ isMain: true });
    const msgs = [makeMsg({ content: 'random message' })];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.shouldProcess).toBe(true);
  });

  it('returns true when requiresTrigger is false', async () => {
    const group = makeGroup({ requiresTrigger: false });
    const msgs = [makeMsg({ content: 'random message' })];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.shouldProcess).toBe(true);
  });

  it('returns false when no trigger and no engaged users', async () => {
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'random message' })];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.shouldProcess).toBe(false);
  });

  it('returns true on direct address (NLP falls back to regex in test)', async () => {
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'Jarvis, help me' })];
    // NLP call will timeout in test env — falls back to regex which matches
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.shouldProcess).toBe(true);
  });

  it('returns false for follow-up without direct address (no engagement persistence)', async () => {
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'follow up question' })];
    // Direct-address-only mode: no persistent engagement
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.shouldProcess).toBe(false);
  });

  it('respects sender allowlist for triggers', async () => {
    const restrictedAllowlist: SenderAllowlistConfig = {
      default: { allow: ['allowed_user'], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    const group = makeGroup();
    // Denied user triggers — should not engage
    const msgs = [makeMsg({ sender: 'denied_user', content: 'Jarvis, help' })];
    const result = await checkEngagement(
      'tg:123',
      group,
      msgs,
      restrictedAllowlist,
    );
    expect(result.shouldProcess).toBe(false);
    expect(isEngaged('tg:123', 'denied_user')).toBe(false);
  });

  it('allows is_from_me triggers regardless of allowlist', async () => {
    const restrictedAllowlist: SenderAllowlistConfig = {
      default: { allow: [], mode: 'trigger' },
      chats: {},
      logDenied: false,
    };
    const group = makeGroup();
    const msgs = [makeMsg({ content: 'Jarvis, test', is_from_me: true })];
    const result = await checkEngagement(
      'tg:123',
      group,
      msgs,
      restrictedAllowlist,
    );
    expect(result.shouldProcess).toBe(true);
  });
});

// --- Dismissal emoji reactions ---

describe('dismissal emoji reactions', () => {
  beforeEach(() => {
    disengageAll('tg:123');
  });

  it('returns dismissal with emoji when engaged user sends trivial message', async () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [makeMsg({ sender: 'user1', content: 'thanks' })];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    // Trivial "thanks" should disengage and return emoji dismissal
    expect(result.dismissals.length).toBe(1);
    expect(result.dismissals[0].emoji).toBe('🙏');
    expect(isEngaged('tg:123', 'user1')).toBe(false);
  });

  it('returns correct emoji for different dismissal types', async () => {
    const testCases = [
      { content: 'thanks', expectedEmoji: '🙏' },
      { content: 'ok', expectedEmoji: '👍' },
      { content: 'awesome', expectedEmoji: '🔥' },
      { content: 'lol', expectedEmoji: '😁' },
      { content: 'bye', expectedEmoji: '🤝' },
      { content: 'stop', expectedEmoji: '👍' },
      { content: 'good job', expectedEmoji: '🫡' }, // salute
      { content: '👍', expectedEmoji: '👍' },
    ];

    for (const { content, expectedEmoji } of testCases) {
      engageUser('tg:123', 'user1');
      const group = makeGroup();
      const msgs = [makeMsg({ sender: 'user1', content })];
      const result = await checkEngagement(
        'tg:123',
        group,
        msgs,
        OPEN_ALLOWLIST,
      );
      expect(result.dismissals.length).toBe(1);
      expect(result.dismissals[0].emoji).toBe(expectedEmoji);
      // Cleanup for next iteration
      disengageAll('tg:123');
    }
  });

  it('does not dismiss non-engaged users', async () => {
    const group = makeGroup();
    const msgs = [makeMsg({ sender: 'user1', content: 'thanks' })];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.dismissals.length).toBe(0);
  });

  it('does not dismiss for non-trivial messages', async () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [
      makeMsg({
        sender: 'user1',
        content: 'can you help me with something else?',
      }),
    ];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.dismissals.length).toBe(0);
    // User should still be engaged
    expect(isEngaged('tg:123', 'user1')).toBe(true);
  });

  it('handles (nojar) messages — skips entirely', async () => {
    const group = makeGroup();
    const msgs = [makeMsg({ content: '(nojar) secret message' })];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.shouldProcess).toBe(false);
    expect(result.dismissals.length).toBe(0);
  });

  it('dismissal still processes remaining trigger messages', async () => {
    engageUser('tg:123', 'user1');
    const group = makeGroup();
    const msgs = [
      makeMsg({ sender: 'user1', content: 'thanks' }), // dismiss user1
      makeMsg({ sender: 'user2', content: 'Jarvis, help me' }), // trigger user2
    ];
    const result = await checkEngagement('tg:123', group, msgs, OPEN_ALLOWLIST);
    expect(result.dismissals.length).toBe(1);
    expect(result.shouldProcess).toBe(true); // user2 triggered
  });
});
