import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CANCEL_PATTERN,
  CREDENTIAL_PROXY_PORT,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  JARVIS_BOT_TOKEN,
  TELEGRAM_BOT_POOL,
  TIMEZONE,
} from './config.js';
import {
  initBotPool,
  initJarvisBot,
  reactToMessage,
  removeReaction,
  sendJarvisMessage,
} from './channels/telegram.js';
import { startCredentialProxy } from './credential-proxy.js';
import {
  checkEngagement,
  disengageAll,
  disengageUser,
  isEngaged,
  learnUserEmoji,
} from './engagement.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { ContainerOutput, runContainerAgent } from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllRegisteredGroups,
  getAllSessions,
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
import {
  markUserActivity,
  sendOrEditStatus,
  sendStoppedStatus,
  startIpcWatcher,
} from './ipc.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
  isGroupChatJid,
  stripReasoning,
} from './router.js';
import {
  getAvailableGroups as getAvailableGroupsFromSnapshots,
  prepareAndWriteSnapshots,
  writeGroupsSnapshot,
} from './snapshots.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { cancelVideoBackends } from './video-cancel.js';
import { logger } from './logger.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

// Tracks trigger message IDs per chatJid for reply-to and reaction clearing
// Multiple messages can arrive before a response — all need reactions cleared
const pendingTriggerMessageIds: Record<string, number[]> = {};

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

/** @internal - wraps snapshots.getAvailableGroups with module state. Used by routing.test.ts. */
export function getAvailableGroups(): import('./snapshots.js').AvailableGroup[] {
  return getAvailableGroupsFromSnapshots(registeredGroups);
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

  // Unified engagement check: trigger detection, per-user prefs, dismissal
  const engagement = await checkEngagement(
    chatJid,
    group,
    missedMessages,
    loadSenderAllowlist(),
  );
  // React to trivial dismissals with emoji
  for (const d of engagement.dismissals) {
    const msgId = parseInt(d.message.id, 10);
    if (!isNaN(msgId)) reactToMessage(chatJid, msgId, d.emoji).catch(() => {});
  }
  if (!engagement.shouldProcess) return true;

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
        if (!userId || userId === 'all') {
          disengageAll(chatJid);
        } else {
          disengageUser(chatJid, userId);
        }
      }
      text = text
        .replace(/<disengage[^>]*\/?>/g, '')
        .replace(/<\/disengage>/g, '')
        .trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);

      // Safety net: strip any reasoning blocks that leak through (container should not inject them)
      if (text) {
        const { text: stripped, reasoning } = stripReasoning(text);
        if (reasoning) {
          text = stripped;
          logger.info(
            { group: group.name, chars: reasoning.length },
            'Stripped leaked reasoning block',
          );
        }
      }

      if (text) {
        let sentMsgId: number | null = null;
        if (group.containerConfig?.ollamaRunner) {
          // Reply to the oldest pending trigger message for the first response only
          const pending = pendingTriggerMessageIds[chatJid];
          const replyTo =
            !outputSentToUser && pending?.length ? pending[0] : undefined;
          sentMsgId = await sendJarvisMessage(chatJid, text, replyTo);
          // Remove reactions from ALL pending trigger messages
          if (pending?.length) {
            for (const msgId of pending) {
              removeReaction(chatJid, msgId).catch((err) =>
                logger.warn(
                  { chatJid, msgId, err },
                  'Failed to remove reaction',
                ),
              );
            }
            pendingTriggerMessageIds[chatJid] = [];
          }
        } else {
          await channel.sendMessage(chatJid, text);
        }
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      // If agent completed without sending any text, salute to acknowledge the action
      if (!outputSentToUser && !result.result) {
        const pending = pendingTriggerMessageIds[chatJid];
        if (pending?.length) {
          reactToMessage(chatJid, pending[pending.length - 1], '🫡').catch(
            () => {},
          );
        }
      }
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

  // Write task + group snapshots for container to read
  prepareAndWriteSnapshots(group.folder, isMain, registeredGroups);

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

    // Safety net: wrappedOnOutput handles session tracking during streaming,
    // but this catches the final output when onOutput is undefined (task-scheduler path).
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
 *
 * Circuit breaker: after 3 consecutive fast failures (<10s each), sends one error
 * message and stops retrying. Prevents crash-loop spam to Telegram.
 */
const prespawnFailures: Record<string, { count: number; lastError: string }> =
  {};
const MAX_PRESPAWN_RETRIES = 3;

function prespawnGroup(chatJid: string, group: RegisteredGroup): void {
  if (shuttingDown) return;

  const spawnStart = Date.now();
  const doSpawn = async () => {
    const isMain = group.isMain === true;
    const sessionId = sessions[group.folder];

    prepareAndWriteSnapshots(group.folder, isMain, registeredGroups);

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
            const pending = pendingTriggerMessageIds[chatJid];
            await sendJarvisMessage(
              chatJid,
              text,
              pending?.length ? pending[0] : undefined,
            );
            // Remove reactions from ALL pending trigger messages
            if (pending?.length) {
              for (const msgId of pending) {
                removeReaction(chatJid, msgId).catch((err) =>
                  logger.warn(
                    { chatJid, msgId, err },
                    'Failed to remove reaction after prespawn response',
                  ),
                );
              }
              pendingTriggerMessageIds[chatJid] = [];
            }
          }
        }
      },
    );
  };

  queue.prespawn(chatJid, group.folder, doSpawn).finally(() => {
    if (shuttingDown) return;

    const duration = Date.now() - spawnStart;
    const isQuickCrash = duration < 10_000;

    if (isQuickCrash) {
      const state = (prespawnFailures[group.folder] ??= {
        count: 0,
        lastError: '',
      });
      state.count++;

      if (state.count >= MAX_PRESPAWN_RETRIES) {
        logger.error(
          { group: group.name, failures: state.count, duration },
          'Container crash loop detected — stopping retries',
        );
        sendJarvisMessage(
          chatJid,
          `_${group.containerConfig?.assistantName || ASSISTANT_NAME} offline — container crashed ${state.count} times in a row. Check logs or redeploy._`,
        ).catch(() => {});
        return; // Stop retrying
      }

      // Exponential backoff: 2s, 4s, 8s...
      const backoff = Math.min(2000 * Math.pow(2, state.count - 1), 30_000);
      logger.warn(
        { group: group.name, failures: state.count, backoffMs: backoff },
        'Container quick crash — retrying with backoff',
      );
      setTimeout(() => prespawnGroup(chatJid, group), backoff);
    } else {
      // Normal exit (long-lived container) — reset and restart promptly
      delete prespawnFailures[group.folder];
      setTimeout(() => prespawnGroup(chatJid, group), 1000);
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

          // Unified engagement check: trigger detection, per-user prefs, dismissal
          const engResult = await checkEngagement(
            chatJid,
            group,
            groupMessages,
            allowlistCfg,
          );
          // React to trivial dismissals with emoji
          for (const d of engResult.dismissals) {
            const msgId = parseInt(d.message.id, 10);
            if (!isNaN(msgId))
              reactToMessage(chatJid, msgId, d.emoji).catch(() => {});
          }
          if (!engResult.shouldProcess) continue;

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
            if (!isNaN(numId)) {
              if (!pendingTriggerMessageIds[chatJid])
                pendingTriggerMessageIds[chatJid] = [];
              pendingTriggerMessageIds[chatJid].push(numId);
              // Instant acknowledgment reaction (must be from Telegram's allowed set)
              reactToMessage(chatJid, numId, '👀').catch((err) =>
                logger.debug(
                  { chatJid, numId, err },
                  'Acknowledgment reaction failed',
                ),
              );
            }
          }

          // Cancel command: pipe to container for immediate IPC cancel, then kill as backup
          const isCancelCommand = groupMessages.some((m) =>
            CANCEL_PATTERN.test(m.content.trim()),
          );
          if (isCancelCommand) {
            // Pipe cancel to container so IPC poll loop catches it (~100ms)
            queue.sendMessage(chatJid, 'cancel');
            // Backup: kill container after 2s if IPC cancel didn't exit
            setTimeout(() => {
              if (queue.killActive(chatJid)) {
                logger.info({ chatJid }, 'Container killed by cancel backup');
              }
            }, 2000);
            lastAgentTimestamp[chatJid] =
              groupMessages[groupMessages.length - 1].timestamp;
            saveState();
            cancelVideoBackends().catch(() => {});
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
  let shutdownCalled = false;
  const shutdown = async (signal: string) => {
    if (shutdownCalled) return; // prevent double-shutdown from multiple signals
    shutdownCalled = true;
    logger.info({ signal }, 'Shutdown signal received');
    shuttingDown = true;

    // Send stopped status — edits the previous online message in place.
    // Only runs if process has been up >10s (prevents spam during crash loops).
    if (Date.now() - startedAt > 10_000) {
      await sendStoppedStatus(registeredGroups, ASSISTANT_NAME);
    }

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
      // (nojar) — completely invisible to Jarvis: don't store, don't learn, don't process
      if (/\(nojar\)/i.test(msg.content)) return;

      storeMessage(msg);

      // Learn user's emoji style from every message
      if (!msg.is_from_me) learnUserEmoji(chatJid, msg.sender, msg.content);

      // Mark user activity so status messages send new instead of editing
      if (!msg.is_from_me) markUserActivity(chatJid);

      // Collect images from photo messages into a per-chat buffer
      if (msg.images && msg.images.length > 0) {
        if (!pendingImages[chatJid]) pendingImages[chatJid] = [];
        pendingImages[chatJid].push(...msg.images);
        pendingImageTimestamps[chatJid] = Date.now();

        // Persist to group folder async so active containers can access via loadLatestImage()
        const group = registeredGroups[chatJid];
        if (group?.containerConfig?.ollamaRunner) {
          const groupDir = resolveGroupFolderPath(group.folder);
          const latestImageFile = path.join(groupDir, '.latest-image.json');
          fs.promises
            .writeFile(
              latestImageFile,
              JSON.stringify({ images: msg.images, savedAt: Date.now() }),
            )
            .catch((err) =>
              logger.debug(
                { chatJid, err },
                'Failed to persist latest image to group folder',
              ),
            );
        }
      }

      // Persist received video to group folder async for video generation context
      if (msg.videoBase64) {
        const group = registeredGroups[chatJid];
        if (group?.containerConfig?.ollamaRunner) {
          const groupDir = resolveGroupFolderPath(group.folder);
          const videoPath = path.join(groupDir, '.latest-video.mp4');
          const metaPath = path.join(groupDir, '.latest-video.json');
          const videoBuf = Buffer.from(msg.videoBase64, 'base64');
          Promise.all([
            fs.promises.writeFile(videoPath, videoBuf),
            fs.promises.writeFile(
              metaPath,
              JSON.stringify({ savedAt: Date.now() }),
            ),
          ])
            .then(() =>
              logger.debug(
                { chatJid },
                'Latest video persisted to group folder',
              ),
            )
            .catch((err) =>
              logger.debug(
                { chatJid, err },
                'Failed to persist latest video to group folder',
              ),
            );
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
    isUserEngaged: (chatJid: string, userId: string) =>
      isEngaged(chatJid, userId),
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
    getAvailableGroups: () => getAvailableGroupsFromSnapshots(registeredGroups),
    writeGroupsSnapshot,
    getLastTriggerMessageId: (chatJid: string) =>
      pendingTriggerMessageIds[chatJid]?.[0],
  });
  queue.setProcessMessagesFn(processGroupMessages);

  // Send online status from host (bot is initialized, can pin)
  {
    const buildId = (() => {
      try {
        return fs
          .readFileSync(
            path.join(process.cwd(), 'container/ollama-runner/build-id.txt'),
            'utf-8',
          )
          .trim();
      } catch {
        return '?';
      }
    })();
    const onlineTime = new Date().toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      if (!group.containerConfig?.ollamaRunner) continue;
      if (!chatJid.startsWith('tg:') && !chatJid.startsWith('tg-j:')) continue;
      const name = group.containerConfig.assistantName || ASSISTANT_NAME;
      sendOrEditStatus(
        chatJid,
        `_${name} v${buildId} online — ${onlineTime}_ 😎`,
      )
        .then(() => logger.info({ chatJid }, 'Host online status sent'))
        .catch((err) =>
          logger.warn({ chatJid, err }, 'Host online status failed'),
        );
    }
  }

  // Pre-spawn persistent containers for all ollama-runner groups
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (group.containerConfig?.ollamaRunner) {
      prespawnGroup(chatJid, group);
    }
  }

  // Skip recovery — don't auto-respond to messages that arrived while offline.
  // Advance cursors to now so only new messages trigger responses.
  for (const [chatJid] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      lastAgentTimestamp[chatJid] || '',
      ASSISTANT_NAME,
    );
    if (pending.length > 0) {
      lastAgentTimestamp[chatJid] = pending[pending.length - 1].timestamp;
      logger.info(
        { chatJid, skipped: pending.length },
        'Skipped pending messages from before restart',
      );
    }
  }
  saveState();

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
