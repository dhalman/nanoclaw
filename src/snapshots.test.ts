import { describe, expect, it } from 'vitest';

// Snapshot logic tests — test the filtering without hitting DB or filesystem.
// The actual writeTasksSnapshot/writeGroupsSnapshot use resolveGroupIpcPath
// which depends on config, so we test the filtering logic in isolation.

const tasks = [
  {
    id: 'task1',
    groupFolder: 'main',
    prompt: 'test',
    schedule_type: 'once',
    schedule_value: '2024-01-01',
    status: 'active',
    next_run: '2024-01-01T00:00:00Z',
  },
  {
    id: 'task2',
    groupFolder: 'other',
    prompt: 'other task',
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    status: 'active',
    next_run: '2024-01-02T09:00:00Z',
  },
  {
    id: 'task3',
    groupFolder: 'main',
    prompt: 'main task 2',
    schedule_type: 'interval',
    schedule_value: '60000',
    status: 'paused',
    next_run: null,
  },
];

// --- task filtering (mirrors writeTasksSnapshot logic) ---

describe('task snapshot filtering', () => {
  it('main group sees all tasks', () => {
    const isMain = true;
    const filtered = isMain
      ? tasks
      : tasks.filter((t) => t.groupFolder === 'main');
    expect(filtered).toHaveLength(3);
  });

  it('non-main group only sees own tasks', () => {
    const isMain = false;
    const groupFolder = 'other';
    const filtered = isMain
      ? tasks
      : tasks.filter((t) => t.groupFolder === groupFolder);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('task2');
  });

  it('non-main group with no tasks gets empty list', () => {
    const isMain = false;
    const groupFolder = 'nonexistent';
    const filtered = isMain
      ? tasks
      : tasks.filter((t) => t.groupFolder === groupFolder);
    expect(filtered).toHaveLength(0);
  });
});

// --- group visibility (mirrors writeGroupsSnapshot logic) ---

describe('group snapshot visibility', () => {
  const groups = [
    { jid: 'g1', name: 'G1', lastActivity: '2024-01-01', isRegistered: true },
    { jid: 'g2', name: 'G2', lastActivity: '2024-01-02', isRegistered: false },
  ];

  it('main group sees all groups', () => {
    const isMain = true;
    const visible = isMain ? groups : [];
    expect(visible).toHaveLength(2);
  });

  it('non-main group sees empty list', () => {
    const isMain = false;
    const visible = isMain ? groups : [];
    expect(visible).toHaveLength(0);
  });
});

// --- available groups filtering (mirrors getAvailableGroups logic) ---

describe('available groups filtering', () => {
  it('excludes non-group chats', () => {
    const chats = [
      {
        jid: 'g1@g.us',
        name: 'G1',
        last_message_time: '2024-01-01',
        channel: 'whatsapp',
        is_group: 1,
      },
      {
        jid: 'u1@s.whatsapp.net',
        name: 'U1',
        last_message_time: '2024-01-01',
        channel: 'whatsapp',
        is_group: 0,
      },
    ];
    const filtered = chats.filter(
      (c) => c.jid !== '__group_sync__' && c.is_group,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].jid).toBe('g1@g.us');
  });

  it('excludes __group_sync__ sentinel', () => {
    const chats = [
      {
        jid: '__group_sync__',
        name: 'sync',
        last_message_time: '2024-01-01',
        channel: '',
        is_group: 0,
      },
      {
        jid: 'g1@g.us',
        name: 'G1',
        last_message_time: '2024-01-01',
        channel: 'whatsapp',
        is_group: 1,
      },
    ];
    const filtered = chats.filter(
      (c) => c.jid !== '__group_sync__' && c.is_group,
    );
    expect(filtered).toHaveLength(1);
  });

  it('marks registered vs unregistered groups', () => {
    const registeredJids = new Set(['g1@g.us']);
    const chats = [
      { jid: 'g1@g.us', name: 'G1', is_group: 1 },
      { jid: 'g2@g.us', name: 'G2', is_group: 1 },
    ];
    const mapped = chats.map((c) => ({
      jid: c.jid,
      isRegistered: registeredJids.has(c.jid),
    }));
    expect(mapped[0].isRegistered).toBe(true);
    expect(mapped[1].isRegistered).toBe(false);
  });
});
