import fs from 'fs';
import { SENDER_ALLOWLIST_PATH } from './config.js';
import { logger } from './logger.js';
const DEFAULT_CONFIG = {
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: true,
};
function isValidEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return false;
    const e = entry;
    const validAllow = e.allow === '*' ||
        (Array.isArray(e.allow) && e.allow.every((v) => typeof v === 'string'));
    const validMode = e.mode === 'trigger' || e.mode === 'drop';
    return validAllow && validMode;
}
let _allowlistCache = null;
let _allowlistCacheExpiry = 0;
const ALLOWLIST_CACHE_TTL_MS = 1000;
export function loadSenderAllowlist(pathOverride) {
    const filePath = pathOverride ?? SENDER_ALLOWLIST_PATH;
    // Return cached value if still fresh (skip for path overrides used in tests)
    if (!pathOverride && _allowlistCache && Date.now() < _allowlistCacheExpiry) {
        return _allowlistCache;
    }
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return DEFAULT_CONFIG;
        logger.warn({ err, path: filePath }, 'sender-allowlist: cannot read config');
        return DEFAULT_CONFIG;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        logger.warn({ path: filePath }, 'sender-allowlist: invalid JSON');
        return DEFAULT_CONFIG;
    }
    const obj = parsed;
    if (!isValidEntry(obj.default)) {
        logger.warn({ path: filePath }, 'sender-allowlist: invalid or missing default entry');
        return DEFAULT_CONFIG;
    }
    const chats = {};
    if (obj.chats && typeof obj.chats === 'object') {
        for (const [jid, entry] of Object.entries(obj.chats)) {
            if (isValidEntry(entry)) {
                chats[jid] = entry;
            }
            else {
                logger.warn({ jid, path: filePath }, 'sender-allowlist: skipping invalid chat entry');
            }
        }
    }
    const result = {
        default: obj.default,
        chats,
        logDenied: obj.logDenied !== false,
    };
    if (!pathOverride) {
        _allowlistCache = result;
        _allowlistCacheExpiry = Date.now() + ALLOWLIST_CACHE_TTL_MS;
    }
    return result;
}
function getEntry(chatJid, cfg) {
    return cfg.chats[chatJid] ?? cfg.default;
}
export function isSenderAllowed(chatJid, sender, cfg) {
    const entry = getEntry(chatJid, cfg);
    if (entry.allow === '*')
        return true;
    return entry.allow.includes(sender);
}
export function shouldDropMessage(chatJid, cfg) {
    return getEntry(chatJid, cfg).mode === 'drop';
}
export function isTriggerAllowed(chatJid, sender, cfg) {
    const allowed = isSenderAllowed(chatJid, sender, cfg);
    if (!allowed && cfg.logDenied) {
        logger.debug({ chatJid, sender }, 'sender-allowlist: trigger denied for sender');
    }
    return allowed;
}
//# sourceMappingURL=sender-allowlist.js.map