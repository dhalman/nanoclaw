import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  JARVIS_BOT_TOKEN,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  initBotPool,
  initJarvisBot,
  sendJarvisMessage,
} from './channels/telegram.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { sendStoppedStatus, startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { cancelVideoBackends } from './video-cancel.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Tracks the last trigger message ID per chatJid for reply-to in groups
const lastTriggerMessageId: Record<string, number> = {};

// Per-group set of user IDs Jarvis is currently engaged with.
// A user becomes engaged when they trigger Jarvis by name.
// Jarvis disengages a user by including <disengage:userId/> in his farewell.
const engagedUsers: Record<string, Set<string>> = {};

// Pending images per chatJid (base64). Accumulated from incoming photo messages,
// consumed (and cleared) when an agent is spawned for that chatJid.
const pendingImages: Record<string, string[]> = {};
const pendingImageTimestamps: Record<string, number> = {};
const PENDING_IMAGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    if (!engagedUsers[chatJid]) engagedUsers[chatJid] = new Set();
    const engaged = engagedUsers[chatJid];
    const triggerMessages = missedMessages.filter(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    const engagedMessages = missedMessages.filter(
      (m) => !m.is_from_me && engaged.has(m.sender),
    );
    if (triggerMessages.length === 0 && engagedMessages.length === 0)
      return true;
    for (const m of triggerMessages) {
      if (m.sender && !engaged.has(m.sender)) {
        engaged.add(m.sender);
        logger.info({ chatJid, user: m.sender }, 'Engaged mode: user on');
      }
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      let text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '');
      // <disengage:userId/> — disengage a specific user
      // <disengage/> or <disengage:all/> — disengage all users (group mode off)
      const disengageMatches = text.matchAll(
        /<disengage(?::([^/]*))?\/?>|<disengage(?::([^>]*))?>(?:<\/disengage>)?/g,
      );
      for (const match of disengageMatches) {
        const userId = (match[1] || match[2] || '').trim();
        if (engagedUsers[chatJid]) {
          if (!userId || userId === 'all') {
            engagedUsers[chatJid].clear();
            logger.info({ chatJid }, 'Engaged mode: all users disengaged');
          } else {
            engagedUsers[chatJid].delete(userId);
            logger.info(
              { chatJid, user: userId },
              'Engaged mode: user disengaged',
            );
          }
        }
      }
      text = text
        .replace(/<disengage[^>]*\/?>/g, '')
        .replace(/<\/disengage>/g, '')
        .trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        if (group.containerConfig?.ollamaRunner) {
          // Reply to the trigger message for the first response only
          const replyTo = !outputSentToUser
            ? lastTriggerMessageId[chatJid]
            : undefined;
          await sendJarvisMessage(chatJid, text, replyTo);
        } else {
          await channel.sendMessage(chatJid, text);
        }
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  // Consume pending images for this chat (skip if stale)
  const imageAge = Date.now() - (pendingImageTimestamps[chatJid] || 0);
  const images =
    imageAge < PENDING_IMAGE_TTL_MS ? pendingImages[chatJid] : undefined;
  delete pendingImages[chatJid];
  delete pendingImageTimestamps[chatJid];

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: group.containerConfig?.assistantName || ASSISTANT_NAME,
        images: images && images.length > 0 ? images : undefined,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

let shuttingDown = false;

/**
 * Pre-spawn a persistent ollama-runner container at startup.
 * The container runs startBackgroundInit() immediately, then waits in its IPC loop.
 * First user message is routed via IPC for instant response.
 * Automatically restarts on exit (unless shutting down).
 */
function prespawnGroup(chatJid: string, group: RegisteredGroup): void {
  if (shuttingDown) return;

  const doSpawn = async () => {
    const isMain = group.isMain === true;
    const sessionId = sessions[group.folder];

    writeTasksSnapshot(
      group.folder,
      isMain,
      getAllTasks().map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );
    writeGroupsSnapshot(
      group.folder,
      isMain,
      getAvailableGroups(),
      new Set(Object.keys(registeredGroups)),
    );

    await runContainerAgent(
      group,
      {
        prompt: '',
        prespin: true,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: group.containerConfig?.assistantName || ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      async (output) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        if (output.result) {
          const text = output.result
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            await sendJarvisMessage(
              chatJid,
              text,
              lastTriggerMessageId[chatJid],
            );
            delete lastTriggerMessageId[chatJid]; // only reply-to on first response
          }
        }
      },
    );
  };

  queue.prespawn(chatJid, group.folder, doSpawn).finally(() => {
    if (!shuttingDown) {
      // Brief pause before restart so deploy's stop/start cycle doesn't double-spawn
      setTimeout(() => prespawnGroup(chatJid, group), 3000);
    }
  });
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      // Evict stale pending images (no agent spawned within TTL)
      const now = Date.now();
      for (const jid of Object.keys(pendingImageTimestamps)) {
        if (now - pendingImageTimestamps[jid] > PENDING_IMAGE_TTL_MS) {
          delete pendingImages[jid];
          delete pendingImageTimestamps[jid];
        }
      }

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Load allowlist once per batch (may be used by every group)
        const allowlistCfg = loadSenderAllowlist();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          if (needsTrigger) {
            if (!engagedUsers[chatJid]) engagedUsers[chatJid] = new Set();
            const engaged = engagedUsers[chatJid];

            // Check which messages have a trigger or come from engaged users
            const triggerMessages = groupMessages.filter(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            const engagedMessages = groupMessages.filter(
              (m) => !m.is_from_me && engaged.has(m.sender),
            );

            if (triggerMessages.length === 0 && engagedMessages.length === 0)
              continue;

            // Engage any new users who triggered by name
            for (const m of triggerMessages) {
              if (m.sender && !engaged.has(m.sender)) {
                engaged.add(m.sender);
                logger.info(
                  { chatJid, user: m.sender },
                  'Engaged mode: user on',
                );
              }
            }
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Track the last user message ID for reply-to in groups
          const lastUserMsg = [...groupMessages]
            .reverse()
            .find((m) => !m.is_from_me);
          if (lastUserMsg?.id) {
            const numId = parseInt(lastUserMsg.id, 10);
            if (!isNaN(numId)) lastTriggerMessageId[chatJid] = numId;
          }

          // Cancel command: kill the active container immediately
          const CANCEL_PATTERN =
            /^\s*(\/stop|\/cancel|stop|cancel|nevermind)\s*$/i;
          const isCancelCommand = groupMessages.some(
            (m) => m.is_from_me && CANCEL_PATTERN.test(m.content.trim()),
          );
          if (isCancelCommand && queue.killActive(chatJid)) {
            logger.info(
              { chatJid },
              'Active container killed by cancel command',
            );
            lastAgentTimestamp[chatJid] =
              groupMessages[groupMessages.length - 1].timestamp;
            saveState();
            cancelVideoBackends().catch(() => {});
            channel.sendMessage?.(chatJid, '_Stopped._')?.catch(() => {});
          } else if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const startedAt = Date.now();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    shuttingDown = true;

    // Stopped status disabled — was causing spam during restart cycles.
    // The "online" status on startup is sufficient; "stopped" adds noise.

    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);

      // Collect images from photo messages into a per-chat buffer
      if (msg.images && msg.images.length > 0) {
        if (!pendingImages[chatJid]) pendingImages[chatJid] = [];
        pendingImages[chatJid].push(...msg.images);
        pendingImageTimestamps[chatJid] = Date.now();

        // Also persist to group folder so active containers can access them via loadLatestImage()
        const group = registeredGroups[chatJid];
        if (group?.containerConfig?.ollamaRunner) {
          try {
            const groupDir = resolveGroupFolderPath(group.folder);
            const latestImageFile = path.join(groupDir, '.latest-image.json');
            fs.writeFileSync(
              latestImageFile,
              JSON.stringify({ images: msg.images, savedAt: Date.now() }),
            );
          } catch (err) {
            logger.debug(
              { chatJid, err },
              'Failed to persist latest image to group folder',
            );
          }
        }
      }

      // Persist received video to group folder for video generation context
      if (msg.videoBase64) {
        const group = registeredGroups[chatJid];
        if (group?.containerConfig?.ollamaRunner) {
          try {
            const groupDir = resolveGroupFolderPath(group.folder);
            const videoPath = path.join(groupDir, '.latest-video.mp4');
            const metaPath = path.join(groupDir, '.latest-video.json');
            fs.writeFileSync(videoPath, Buffer.from(msg.videoBase64, 'base64'));
            fs.writeFileSync(metaPath, JSON.stringify({ savedAt: Date.now() }));
            logger.debug({ chatJid }, 'Latest video persisted to group folder');
          } catch (err) {
            logger.debug(
              { chatJid, err },
              'Failed to persist latest video to group folder',
            );
          }
        }
      }
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  if (TELEGRAM_BOT_POOL.length > 0) {
    await initBotPool(TELEGRAM_BOT_POOL);
  }

  if (JARVIS_BOT_TOKEN) {
    await initJarvisBot(JARVIS_BOT_TOKEN, channelOpts);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // Pre-spawn persistent containers for all ollama-runner groups
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.containerConfig?.ollamaRunner) {
      prespawnGroup(chatJid, group);
    }
  }

  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
