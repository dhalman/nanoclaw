import fs from 'fs';
import path from 'path';
import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from './config.js';
import { logger } from './logger.js';
import { isTriggerAllowed } from './sender-allowlist.js';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const INTENT_MODEL = process.env.OLLAMA_MODEL_SECRETARY || 'qwen2.5:3b';
// Fast regex: does the message mention the assistant name at all?
const MENTION_PATTERN = new RegExp(`\\b${ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
/**
 * NLP intent check: is this message directed at the assistant, or just mentioning them?
 */
async function classifyIntent(text) {
    try {
        const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: INTENT_MODEL,
                messages: [
                    {
                        role: 'system',
                        content: `Is "${ASSISTANT_NAME}" being SPOKEN TO (greetings, questions, requests, commands) or just MENTIONED in passing (talking about them to someone else)? Reply: "directed" or "mention"`,
                    },
                    { role: 'user', content: text },
                ],
                keep_alive: -1,
                options: { num_ctx: 512, temperature: 0.0, num_predict: 10 },
                stream: false,
            }),
            signal: AbortSignal.timeout(1500),
        });
        if (!resp.ok)
            return null;
        const data = (await resp.json());
        const answer = data.message.content.trim().toLowerCase();
        if (answer.includes('directed') || answer.includes('direct'))
            return 'engage';
        if (answer.includes('mention'))
            return 'observe';
        return null;
    }
    catch {
        return null;
    }
}
// Per-group set of user IDs the assistant is currently engaged with.
const engagedUsers = {};
// Track emoji usage per user — learn their style to mirror back
const userEmojiHistory = {};
const TELEGRAM_EMOJI = [
    '👍',
    '👎',
    '❤',
    '🔥',
    '🥰',
    '👏',
    '😁',
    '🤔',
    '🤯',
    '😱',
    '😢',
    '🎉',
    '🤩',
    '🙏',
    '👌',
    '🤡',
    '🥱',
    '😍',
    '🐳',
    '🌚',
    '💯',
    '🫡',
    '👋',
];
/** Record emojis a user sends so we can mirror their style. */
export function learnUserEmoji(chatJid, userId, text) {
    const key = `${chatJid}:${userId}`;
    if (!userEmojiHistory[key])
        userEmojiHistory[key] = {};
    // Extract emojis from text
    const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}]/gu;
    const emojis = text.match(emojiRegex) || [];
    for (const e of emojis) {
        userEmojiHistory[key][e] = (userEmojiHistory[key][e] || 0) + 1;
    }
}
/** Pick an emoji that mirrors the user's style for a given mood. */
function pickUserEmoji(chatJid, userId, fallback) {
    const key = `${chatJid}:${userId}`;
    const history = userEmojiHistory[key];
    if (!history || Object.keys(history).length === 0)
        return fallback;
    // Find user's most-used emoji that's in Telegram's reaction set
    const sorted = Object.entries(history)
        .filter(([e]) => TELEGRAM_EMOJI.includes(e))
        .sort((a, b) => b[1] - a[1]);
    return sorted.length > 0 ? sorted[0][0] : fallback;
}
function getEngaged(chatJid) {
    if (!engagedUsers[chatJid])
        engagedUsers[chatJid] = new Set();
    return engagedUsers[chatJid];
}
/** Read a user preference from the group's preferences file (host-side). */
export function getUserPref(groupFolder, userId, key) {
    try {
        const prefsPath = path.join(GROUPS_DIR, groupFolder, '.preferences.json');
        if (!fs.existsSync(prefsPath))
            return undefined;
        const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
        const userVal = prefs?.users?.[userId]?.[key];
        if (userVal !== undefined)
            return userVal;
        return prefs?.group?.[key];
    }
    catch {
        return undefined;
    }
}
export function isEngaged(chatJid, userId) {
    return engagedUsers[chatJid]?.has(userId) ?? false;
}
export function engageUser(chatJid, userId) {
    getEngaged(chatJid).add(userId);
    logger.info({ chatJid, user: userId }, 'Engaged');
}
export function disengageUser(chatJid, userId) {
    engagedUsers[chatJid]?.delete(userId);
    logger.info({ chatJid, user: userId }, 'Disengaged');
}
export function disengageAll(chatJid) {
    engagedUsers[chatJid]?.clear();
    logger.info({ chatJid }, 'All disengaged');
}
/**
 * Engagement model:
 * - Direct address (name mention + NLP "directed") → engage, respond
 * - Already engaged → passively listen, respond without name requirement
 * - Dismissal ("bye", "thanks", "done") → disengage, go quiet
 * - After dismissal → only re-engage on direct address or skill-related trigger
 */
export async function checkEngagement(chatJid, group, messages, allowlistCfg) {
    const isMainGroup = group.isMain === true;
    const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
    if (!needsTrigger) {
        // (nojar) tag forces ignore even for main groups
        if (messages.every((m) => /\(nojar\)/i.test(m.content))) {
            return { shouldProcess: false, dismissals: [] };
        }
        return { shouldProcess: true, dismissals: [] };
    }
    // (nojar) tag — force Jarvis to completely ignore the message
    const filtered = messages.filter((m) => !/\(nojar\)/i.test(m.content));
    if (filtered.length === 0)
        return { shouldProcess: false, dismissals: [] };
    const engaged = getEngaged(chatJid);
    // Trivial/dismissal responses: disengage and react with an emoji instead of responding.
    // Returns the emoji to react with, or null if the message is not trivial.
    const TRIVIAL_REACTIONS = [
        { pattern: /^\s*(?:thanks?|thank\s*you|thx|ty)\s*[!.]?\s*$/i, emoji: '🙏' },
        {
            pattern: /^\s*(?:ok|okay|k|kk|got\s*it|understood|roger|copy)\s*[!.]?\s*$/i,
            emoji: '👍',
        },
        {
            pattern: /^\s*(?:awesome|amazing|great|perfect|nice|cool|sweet|fire|lit)\s*[!.]?\s*$/i,
            emoji: '🔥',
        },
        {
            pattern: /^\s*(?:good\s*job|well\s*done|nailed\s*it|bravo)\s*[!.]?\s*$/i,
            emoji: '🫡',
        },
        { pattern: /^\s*(?:lol|lmao|haha|😂|🤣|😆)\s*$/i, emoji: '😁' },
        {
            pattern: /^\s*(?:bye|goodbye|go away|later|peace|cya|see\s*ya)\s*[!.]?\s*$/i,
            emoji: '👋',
        },
        {
            pattern: /^\s*(?:stop|cancel|nevermind|nah|nope|no\s*thanks?|enough|done|that'?s\s*(?:all|enough|it)|i'?m\s*good|we'?re\s*good|whatever|quiet|shut\s*up|leave)\s*[!.]?\s*$/i,
            emoji: '👍',
        },
        { pattern: /^\s*(?:👋|👍|👌|🙏|🫡|💯|✅|🤙)\s*$/i, emoji: '👍' },
    ];
    const dismissedMessages = [];
    for (const m of messages) {
        if (!m.is_from_me && engaged.has(m.sender)) {
            const trivial = TRIVIAL_REACTIONS.find((r) => r.pattern.test(m.content.trim()));
            if (trivial) {
                engaged.delete(m.sender);
                const emoji = pickUserEmoji(chatJid, m.sender, trivial.emoji);
                dismissedMessages.push({ message: m, emoji });
                logger.info({ chatJid, user: m.sender, emoji }, 'Disengaged (trivial)');
            }
        }
        // Learn emoji from all messages (not just trivial) to build user profile
        if (!m.is_from_me)
            learnUserEmoji(chatJid, m.sender, m.content);
    }
    // Already-engaged users: respond to questions/commands, ignore casual chatter
    const engagedMessages = messages.filter((m) => !m.is_from_me && engaged.has(m.sender));
    // Owner triggers (is_from_me) always work via regex
    const ownerTriggers = messages.filter((m) => m.is_from_me && TRIGGER_PATTERN.test(m.content.trim()));
    // New triggers: mention check → NLP intent (only for non-engaged users)
    const candidates = messages.filter((m) => !m.is_from_me &&
        !engaged.has(m.sender) &&
        MENTION_PATTERN.test(m.content.trim()) &&
        isTriggerAllowed(chatJid, m.sender, allowlistCfg));
    const triggerMessages = [...ownerTriggers];
    // Fast path: regex trigger matches are always engaged (no NLP needed)
    // NLP is only for ambiguous cases where name is mentioned but regex doesn't match
    for (const m of candidates) {
        if (TRIGGER_PATTERN.test(m.content.trim())) {
            // Clear regex match — engage immediately, no NLP cost
            triggerMessages.push(m);
        }
        else {
            // Ambiguous: name mentioned but not in a clear trigger pattern
            // Use NLP only here — and with a tight 2s timeout
            const intent = await classifyIntent(m.content.trim());
            if (intent === 'engage') {
                triggerMessages.push(m);
            }
        }
    }
    // Engage new users
    for (const m of triggerMessages) {
        if (m.sender && !engaged.has(m.sender)) {
            engaged.add(m.sender);
            logger.info({ chatJid, user: m.sender }, 'Engaged');
        }
    }
    if (triggerMessages.length === 0 && engagedMessages.length === 0)
        return { shouldProcess: false, dismissals: dismissedMessages };
    return { shouldProcess: true, dismissals: dismissedMessages };
}
//# sourceMappingURL=engagement.js.map