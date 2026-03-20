import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  sendJarvisMessage,
  sendJarvisPhoto,
  sendJarvisVideo,
  sendPoolMessage,
  editJarvisMessage,
  deleteJarvisMessage,
  pinJarvisMessage,
  unpinJarvisMessage,
} from './channels/telegram.js';
import { AvailableGroup } from './snapshots.js';
import { createTask, deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
  ) => void;
}

let ipcWatcherRunning = false;

// Tracks active thinking messages: thinkingId → { chatJid, messageId }
const thinkingMessages = new Map<
  string,
  { chatJid: string; messageId: number }
>();

// Tracks last status message per chatJid (stopped/online) so we can edit it
// instead of sending a new one on restart. Persisted to DB to survive restarts.
import { getRouterState, setRouterState } from './db.js';

// Status message tracking: { messageId, lastWasStatus }
// lastWasStatus = true means no user messages have arrived since the last status.
// When true → edit the existing status. When false → send new (user activity in between).
interface StatusEntry {
  messageId: number;
  lastWasStatus: boolean;
}
let _statusEntries: Map<string, StatusEntry> | null = null;

function getStatusEntries(): Map<string, StatusEntry> {
  if (!_statusEntries) {
    try {
      const raw = getRouterState('last_status_message_ids');
      if (raw) {
        const parsed = JSON.parse(raw);
        _statusEntries = new Map(
          Object.entries(parsed).map(([k, v]) => [k, v as StatusEntry]),
        );
      } else {
        _statusEntries = new Map();
      }
    } catch {
      _statusEntries = new Map();
    }
  }
  return _statusEntries;
}

function saveStatusEntries(): void {
  setRouterState(
    'last_status_message_ids',
    JSON.stringify(Object.fromEntries(getStatusEntries())),
  );
}

/** Call when a user message is received for a chatJid (no-op — status is always edit-in-place now). */
export function markUserActivity(_chatJid: string): void {
  // Kept for API compat — status messages are always edited in place.
}

/**
 * Send or edit a status message. Always edits the existing pinned status
 * message if one exists. Only sends new when there's no prior message ID
 * or the edit fails (message deleted by user).
 */
async function sendOrEditStatus(chatJid: string, text: string): Promise<void> {
  const entries = getStatusEntries();
  const entry = entries.get(chatJid);

  if (entry?.messageId) {
    try {
      await unpinJarvisMessage(chatJid, entry.messageId);
      await editJarvisMessage(chatJid, entry.messageId, text);
      await pinJarvisMessage(chatJid, entry.messageId);
      logger.info(
        { chatJid, messageId: entry.messageId },
        'Status message updated and re-pinned',
      );
      return;
    } catch {
      // Edit failed (message deleted?) — delete the old one and send new
      logger.debug({ chatJid }, 'Could not edit status, replacing');
      await deleteJarvisMessage(chatJid, entry.messageId);
    }
  }

  // Send new status message, pin it, delete the old one if it existed
  const sentId = await sendJarvisMessage(chatJid, text);
  if (sentId) {
    entries.set(chatJid, { messageId: sentId, lastWasStatus: true });
    saveStatusEntries();
    await pinJarvisMessage(chatJid, sentId);
    logger.info(
      { chatJid, messageId: sentId },
      'Status message sent and pinned',
    );
  }
}

function readExpectedBuildId(): string | null {
  try {
    return fs
      .readFileSync(
        path.join(process.cwd(), 'container/ollama-runner/build-id.txt'),
        'utf-8',
      )
      .trim();
  } catch {
    return null;
  }
}

/**
 * Send "stopped" status to all registered groups that use the Jarvis bot.
 * Called from the host shutdown handler so the message is reliably delivered.
 */
export async function sendStoppedStatus(
  registeredGroups: Record<string, RegisteredGroup>,
  assistantName: string,
): Promise<void> {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (!group.containerConfig?.ollamaRunner) continue;
    if (!chatJid.startsWith('tg:') && !chatJid.startsWith('tg-j:')) continue;
    try {
      const stopTime = new Date().toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
      await sendOrEditStatus(
        chatJid,
        `_${assistantName} stopped — ${stopTime}_`,
      );
    } catch (err) {
      logger.debug({ chatJid, err }, 'Failed to send stopped status');
    }
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const expectedBuildId = readExpectedBuildId();

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  // Safe unlink that tolerates ENOENT (file already processed by concurrent watcher)
  const safeUnlink = (filePath: string) => {
    try {
      fs.unlinkSync(filePath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  };

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'errors')
        .map((d) => d.name);
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              let raw: string;
              try {
                raw = fs.readFileSync(filePath, 'utf-8');
              } catch (readErr: unknown) {
                // File already processed by a concurrent watcher — skip
                if ((readErr as NodeJS.ErrnoException).code === 'ENOENT')
                  continue;
                throw readErr;
              }
              const data = JSON.parse(raw);
              if (
                expectedBuildId &&
                data.buildId &&
                data.buildId !== expectedBuildId
              ) {
                logger.debug(
                  { file, dataBuildId: data.buildId, expectedBuildId },
                  'Dropping IPC message from old image',
                );
                safeUnlink(filePath);
                continue;
              }
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    sourceGroup === 'telegram_ollama' &&
                    (data.chatJid.startsWith('tg:') ||
                      data.chatJid.startsWith('tg-j:'))
                  ) {
                    await sendJarvisMessage(data.chatJid, data.text);
                  } else if (data.sender && data.chatJid.startsWith('tg:')) {
                    await sendPoolMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      sourceGroup,
                    );
                  } else {
                    await deps.sendMessage(data.chatJid, data.text);
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (data.type === 'status' && data.chatJid && data.text) {
                // Status messages (stopped/online) — edit if last was status, new if user activity since
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Clear orphaned thinking messages for this chat (container restarted)
                  for (const [tid, entry] of thinkingMessages) {
                    if (entry.chatJid === data.chatJid) {
                      await deleteJarvisMessage(entry.chatJid, entry.messageId);
                      thinkingMessages.delete(tid);
                      logger.info(
                        { chatJid: entry.chatJid, thinkingId: tid },
                        'Cleared orphaned thinking message',
                      );
                    }
                  }
                  await sendOrEditStatus(data.chatJid, data.text);
                }
              } else if (
                data.type === 'image' &&
                data.chatJid &&
                data.imageBase64
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  if (
                    data.chatJid.startsWith('tg:') ||
                    data.chatJid.startsWith('tg-j:')
                  ) {
                    await sendJarvisPhoto(
                      data.chatJid,
                      data.imageBase64,
                      data.caption,
                    );
                  } else {
                    logger.warn(
                      { sourceGroup },
                      'Image IPC to non-Telegram target — not yet supported',
                    );
                  }
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC image sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC image attempt blocked',
                  );
                }
              } else if (
                data.type === 'video' &&
                data.chatJid &&
                data.videoBase64
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendJarvisVideo(
                    data.chatJid,
                    data.videoBase64,
                    data.caption,
                  );
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC video sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC video attempt blocked',
                  );
                }
              } else if (
                data.type === 'thinking_start' &&
                data.chatJid &&
                data.thinkingId &&
                data.text
              ) {
                const msgId = await sendJarvisMessage(data.chatJid, data.text);
                if (msgId !== null) {
                  thinkingMessages.set(data.thinkingId, {
                    chatJid: data.chatJid,
                    messageId: msgId,
                  });
                  logger.debug(
                    { thinkingId: data.thinkingId, msgId },
                    'Thinking message sent',
                  );
                }
              } else if (
                data.type === 'thinking_update' &&
                data.thinkingId &&
                data.text
              ) {
                const entry = thinkingMessages.get(data.thinkingId);
                if (entry) {
                  await editJarvisMessage(
                    entry.chatJid,
                    entry.messageId,
                    data.text,
                  );
                }
              } else if (data.type === 'thinking_clear' && data.thinkingId) {
                const entry = thinkingMessages.get(data.thinkingId);
                if (entry) {
                  await deleteJarvisMessage(entry.chatJid, entry.messageId);
                  thinkingMessages.delete(data.thinkingId);
                  logger.debug(
                    { thinkingId: data.thinkingId },
                    'Thinking message cleared',
                  );
                }
              }
              safeUnlink(filePath);
            } catch (err) {
              // Skip ENOENT — file was already processed by concurrent watcher
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              try {
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                /* file may already be gone */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              let raw: string;
              try {
                raw = fs.readFileSync(filePath, 'utf-8');
              } catch (readErr: unknown) {
                if ((readErr as NodeJS.ErrnoException).code === 'ENOENT')
                  continue;
                throw readErr;
              }
              const data = JSON.parse(raw);
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              safeUnlink(filePath);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              try {
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch {
                /* file may already be gone */
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }
  };

  // Event-driven: watch IPC directories for changes instead of polling.
  // Falls back to a slow poll (5s) as a safety net in case fs.watch misses events.
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const triggerProcessing = () => {
    if (debounceTimer) return; // already scheduled
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      processIpcFiles();
    }, 50); // 50ms debounce to batch rapid writes
  };

  // Watch each group's IPC directories
  const watchers: fs.FSWatcher[] = [];
  const setupWatchers = () => {
    // Clean up old watchers
    for (const w of watchers) w.close();
    watchers.length = 0;

    try {
      const dirs = fs
        .readdirSync(ipcBaseDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name !== 'errors');
      for (const d of dirs) {
        for (const sub of ['messages', 'tasks']) {
          const dir = path.join(ipcBaseDir, d.name, sub);
          if (!fs.existsSync(dir)) continue;
          try {
            const w = fs.watch(dir, { persistent: false }, triggerProcessing);
            watchers.push(w);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  };

  setupWatchers();
  // Re-scan watchers periodically in case new groups were added
  setInterval(setupWatchers, 30_000);
  // Safety net: slow poll in case fs.watch misses events
  setInterval(triggerProcessing, 5_000);

  // Process any existing files immediately
  processIpcFiles();
  logger.info('IPC watcher started (event-driven with 5s safety poll)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For manage_service
    service?: string;
    action?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(sourceGroup, true, availableGroups);
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'rebuild':
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized rebuild attempt blocked');
        break;
      }
      logger.info(
        { sourceGroup },
        'Rebuild requested via IPC — spawning build.sh',
      );
      {
        const buildScript = path.join(process.cwd(), 'container/build.sh');
        const buildProc = spawn(buildScript, [], {
          detached: true,
          stdio: 'ignore',
        });
        buildProc.unref();
      }
      break;

    case 'manage_service': {
      const service = String(data.service ?? '').trim();
      const action = String(data.action ?? 'start').trim();
      const validServices = ['searxng', 'comfyui', 'ollamadiffuser', 'ollama'];
      const validActions = ['start', 'restart'];
      if (!validServices.includes(service)) {
        logger.warn(
          { service, sourceGroup },
          'Invalid service name in manage_service',
        );
        break;
      }
      if (!validActions.includes(action)) {
        logger.warn(
          { action, sourceGroup },
          'Invalid action in manage_service',
        );
        break;
      }
      logger.info(
        { service, action, sourceGroup },
        'Service management requested via IPC',
      );
      const script = path.join(process.cwd(), 'scripts/manage-service.sh');
      const proc = spawn(script, [service, action], {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
