import { SenderAllowlistConfig } from './sender-allowlist.js';
import { NewMessage, RegisteredGroup } from './types.js';
/** Record emojis a user sends so we can mirror their style. */
export declare function learnUserEmoji(chatJid: string, userId: string, text: string): void;
/** Read a user preference from the group's preferences file (host-side). */
export declare function getUserPref(groupFolder: string, userId: string, key: string): unknown;
export declare function isEngaged(chatJid: string, userId: string): boolean;
export declare function engageUser(chatJid: string, userId: string): void;
export declare function disengageUser(chatJid: string, userId: string): void;
export declare function disengageAll(chatJid: string): void;
/**
 * Engagement model:
 * - Direct address (name mention + NLP "directed") → engage, respond
 * - Already engaged → passively listen, respond without name requirement
 * - Dismissal ("bye", "thanks", "done") → disengage, go quiet
 * - After dismissal → only re-engage on direct address or skill-related trigger
 */
export declare function checkEngagement(chatJid: string, group: RegisteredGroup, messages: NewMessage[], allowlistCfg: SenderAllowlistConfig): Promise<{
    shouldProcess: boolean;
    dismissals: Array<{
        message: NewMessage;
        emoji: string;
    }>;
}>;
//# sourceMappingURL=engagement.d.ts.map