import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'DISABLE_SECRETARY',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
// Passed to containers via env var — controls whether secretary LLM classification
// is used (false) or bypassed in favor of keyword classification (true).
export const DISABLE_SECRETARY =
  (process.env.DISABLE_SECRETARY || envConfig.DISABLE_SECRETARY) === '1';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const SEARXNG_PORT = parseInt(process.env.SEARXNG_PORT || '8888', 10);
export const IPC_POLL_INTERVAL = 100;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TELEGRAM_BOT_POOL = (process.env.TELEGRAM_BOT_POOL || '')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

export const JARVIS_BOT_TOKEN = process.env.JARVIS_BOT_TOKEN || '';

// Direct address only — "Jarvis, ..." or "hey Jarvis" or "@Jarvis" or "Jarvis?"
// Does NOT match "Jarvis said..." or "ask Jarvis later" (talking ABOUT, not TO)
export const TRIGGER_PATTERN = new RegExp(
  `(?:^|\\b(?:hey|hi|ok|yo)\\s+)${escapeRegex(ASSISTANT_NAME)}\\b[,?!:]?(?:\\s|$)|` + // "Jarvis, ..." / "hey Jarvis" / "hi Jarvis"
    `(?:^|\\s)@${escapeRegex(ASSISTANT_NAME)}\\b|` + // "@Jarvis"
    `^${escapeRegex(ASSISTANT_NAME)}[,?!:\\s]`, // starts with "Jarvis,"
  'im',
);

// Host-side dismissal: disengage when user sends a clear farewell
export const DISMISS_PATTERN =
  /^\s*(?:bye|goodbye|go away|stop|leave|dismiss|shut up|quiet|enough|done|no thanks?|nah|nope|not now|i'?m good|we'?re good|that'?s (?:all|enough|it)|never\s?mind|whatever|ok bye|k bye|👋)\s*[.!]?\s*$/i;

// Cancel command: kill the active container immediately
export const CANCEL_PATTERN =
  /^\s*(\/stop|\/cancel|stop|cancel|nevermind)\s*$/i;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
