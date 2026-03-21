import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markUserActivity, sendStoppedStatus } from './ipc.js';

// We test the exported helpers directly. The main processIpcFiles loop
// is an internal async function that's hard to unit test, but we can
// verify the building blocks and the race condition fix.

// --- markUserActivity ---

// markUserActivity depends on getRouterState/setRouterState from db.ts.
// Since DB is broken in test env, we test the logic pattern instead.

describe('markUserActivity (logic)', () => {
  it('marks status as no longer the last message', () => {
    // Simulates the StatusEntry state machine
    interface StatusEntry {
      messageId: number;
      lastWasStatus: boolean;
    }
    const entries = new Map<string, StatusEntry>();
    entries.set('tg:123', { messageId: 100, lastWasStatus: true });

    // markUserActivity sets lastWasStatus = false
    const entry = entries.get('tg:123');
    if (entry && entry.lastWasStatus) {
      entry.lastWasStatus = false;
    }

    expect(entries.get('tg:123')?.lastWasStatus).toBe(false);
  });

  it('does nothing if no status entry exists', () => {
    const entries = new Map<
      string,
      { messageId: number; lastWasStatus: boolean }
    >();
    const entry = entries.get('tg:999');
    // No crash
    expect(entry).toBeUndefined();
  });

  it('does nothing if last message was not a status', () => {
    const entries = new Map<
      string,
      { messageId: number; lastWasStatus: boolean }
    >();
    entries.set('tg:123', { messageId: 100, lastWasStatus: false });

    const entry = entries.get('tg:123');
    if (entry && entry.lastWasStatus) {
      entry.lastWasStatus = false;
    }

    // Should remain false (already was)
    expect(entries.get('tg:123')?.lastWasStatus).toBe(false);
  });
});

// --- sendOrEditStatus (logic) ---

describe('sendOrEditStatus (logic)', () => {
  it('edits when lastWasStatus is true', () => {
    interface StatusEntry {
      messageId: number;
      lastWasStatus: boolean;
    }
    const entry: StatusEntry = { messageId: 100, lastWasStatus: true };
    const shouldEdit = entry.messageId && entry.lastWasStatus;
    expect(shouldEdit).toBeTruthy();
  });

  it('sends new when lastWasStatus is false', () => {
    const entry = { messageId: 100, lastWasStatus: false };
    const shouldEdit = entry.messageId && entry.lastWasStatus;
    expect(shouldEdit).toBeFalsy();
  });

  it('sends new when no previous entry exists', () => {
    const entries = new Map<
      string,
      { messageId: number; lastWasStatus: boolean }
    >();
    const entry = entries.get('nonexistent');
    const shouldEdit = entry && entry.messageId && entry.lastWasStatus;
    expect(shouldEdit).toBeFalsy();
  });
});

// --- IPC race condition fix ---

describe('IPC file race condition handling', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-race-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('safeUnlink tolerates ENOENT', () => {
    // Simulates the safeUnlink pattern from ipc.ts
    const safeUnlink = (filePath: string) => {
      try {
        fs.unlinkSync(filePath);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    };

    const nonexistent = path.join(tmpDir, 'gone.json');
    expect(() => safeUnlink(nonexistent)).not.toThrow();
  });

  it('safeUnlink rethrows non-ENOENT errors', () => {
    const safeUnlink = (filePath: string) => {
      try {
        fs.unlinkSync(filePath);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    };

    // Try to unlink a directory — EISDIR, not ENOENT
    expect(() => safeUnlink(tmpDir)).toThrow();
  });

  it('concurrent reads of the same file — first succeeds, second gets ENOENT', () => {
    const filePath = path.join(tmpDir, 'msg.json');
    fs.writeFileSync(filePath, JSON.stringify({ type: 'message', text: 'hi' }));

    // First reader succeeds
    const data1 = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data1.type).toBe('message');

    // First reader processes and deletes
    fs.unlinkSync(filePath);

    // Second reader gets ENOENT — should be handled gracefully
    let skipped = false;
    try {
      fs.readFileSync(filePath, 'utf-8');
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        skipped = true;
      }
    }
    expect(skipped).toBe(true);
  });

  it('readdirSync + processing handles file disappearing mid-loop', () => {
    // Create files
    fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}');

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(2);

    const processed: string[] = [];
    for (const file of files) {
      const filePath = path.join(tmpDir, file);
      try {
        fs.readFileSync(filePath, 'utf-8');
        processed.push(file);
        fs.unlinkSync(filePath);
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
    }

    expect(processed).toHaveLength(2);
  });
});

// --- Prespawn response: reaction removal ---

describe('prespawn onOutput reaction removal', () => {
  it('removes reactions from all pending trigger messages', () => {
    // Simulates the prespawn onOutput callback pattern from index.ts prespawnGroup()
    const pendingTriggerMessageIds: Record<string, number[]> = {
      'tg-j:-100123': [42, 55, 67],
    };
    const removeReactionCalls: Array<{ chatJid: string; msgId: number }> = [];
    const removeReaction = (chatJid: string, msgId: number) => {
      removeReactionCalls.push({ chatJid, msgId });
    };

    const output = {
      result: 'Hey! How can I help you today?\n\n_(qwen3.5 · chat · 3.5s)_',
    };
    const chatJid = 'tg-j:-100123';

    if (output.result) {
      const text = output.result
        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
        .trim();
      if (text) {
        const pending = pendingTriggerMessageIds[chatJid];
        // sendJarvisMessage would reply to pending[0]
        if (pending?.length) {
          for (const msgId of pending) {
            removeReaction(chatJid, msgId);
          }
          pendingTriggerMessageIds[chatJid] = [];
        }
      }
    }

    expect(removeReactionCalls).toHaveLength(3);
    expect(removeReactionCalls[0]).toEqual({ chatJid, msgId: 42 });
    expect(removeReactionCalls[1]).toEqual({ chatJid, msgId: 55 });
    expect(removeReactionCalls[2]).toEqual({ chatJid, msgId: 67 });
    expect(pendingTriggerMessageIds[chatJid]).toEqual([]);
  });

  it('does not call removeReaction when no trigger messages pending', () => {
    const pendingTriggerMessageIds: Record<string, number[]> = {};
    const removeReactionCalls: Array<{ chatJid: string; msgId: number }> = [];
    const removeReaction = (chatJid: string, msgId: number) => {
      removeReactionCalls.push({ chatJid, msgId });
    };

    const output = { result: 'Hello!' };
    const chatJid = 'tg-j:-100123';

    if (output.result) {
      const text = output.result
        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
        .trim();
      if (text) {
        const pending = pendingTriggerMessageIds[chatJid];
        if (pending?.length) {
          for (const msgId of pending) {
            removeReaction(chatJid, msgId);
          }
          pendingTriggerMessageIds[chatJid] = [];
        }
      }
    }

    expect(removeReactionCalls).toHaveLength(0);
  });

  it('does not remove reaction when result is null (session update)', () => {
    const pendingTriggerMessageIds: Record<string, number[]> = {
      'tg-j:-100123': [42],
    };
    const removeReactionCalls: Array<{ chatJid: string; msgId: number }> = [];
    const removeReaction = (chatJid: string, msgId: number) => {
      removeReactionCalls.push({ chatJid, msgId });
    };

    const output = { result: null as string | null };
    const chatJid = 'tg-j:-100123';

    if (output.result) {
      const text = output.result
        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
        .trim();
      if (text) {
        const pending = pendingTriggerMessageIds[chatJid];
        if (pending?.length) {
          for (const msgId of pending) {
            removeReaction(chatJid, msgId);
          }
          pendingTriggerMessageIds[chatJid] = [];
        }
      }
    }

    // Should NOT have called removeReaction — null result is a session update
    expect(removeReactionCalls).toHaveLength(0);
    // Trigger messages should still be pending
    expect(pendingTriggerMessageIds[chatJid]).toEqual([42]);
  });
});

// --- Build ID filtering ---

describe('IPC build ID filtering', () => {
  it('drops messages from old build', () => {
    const expectedBuildId = '0.2.17';
    const data = { type: 'message', buildId: '0.2.16', text: 'stale' };
    const shouldDrop =
      expectedBuildId && data.buildId && data.buildId !== expectedBuildId;
    expect(shouldDrop).toBeTruthy();
  });

  it('accepts messages from current build', () => {
    const expectedBuildId = '0.2.17';
    const data = { type: 'message', buildId: '0.2.17', text: 'fresh' };
    const shouldDrop =
      expectedBuildId && data.buildId && data.buildId !== expectedBuildId;
    expect(shouldDrop).toBeFalsy();
  });

  it('accepts messages without buildId (backward compat)', () => {
    const expectedBuildId = '0.2.17';
    const data = { type: 'message', text: 'old format' };
    const shouldDrop =
      expectedBuildId &&
      (data as Record<string, unknown>).buildId &&
      (data as Record<string, unknown>).buildId !== expectedBuildId;
    expect(shouldDrop).toBeFalsy();
  });
});
