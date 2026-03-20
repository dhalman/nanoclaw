import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';
export interface TelegramChannelOpts {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
    isUserEngaged?: (chatJid: string, userId: string) => boolean;
}
/**
 * Initialize send-only Api instances for the bot pool.
 * Each pool bot can send messages but doesn't poll for updates.
 */
export declare function initBotPool(tokens: string[]): Promise<void>;
/**
 * Send a message via a pool bot assigned to the given sender name.
 * Assigns bots round-robin on first use; subsequent messages from the
 * same sender in the same group always use the same bot.
 * On first assignment, renames the bot to match the sender's role.
 */
export declare function sendPoolMessage(chatId: string, text: string, sender: string, groupFolder: string): Promise<void>;
export declare function initJarvisBot(token: string, opts: TelegramChannelOpts): Promise<void>;
export declare function sendJarvisMessage(chatId: string, text: string, replyToMessageId?: number): Promise<number | null>;
export declare function editJarvisMessage(chatId: string, messageId: number, text: string): Promise<void>;
export declare function deleteJarvisMessage(chatId: string, messageId: number): Promise<void>;
export declare function pinJarvisMessage(chatId: string, messageId: number): Promise<void>;
export declare function reactToMessage(chatId: string, messageId: number, emoji?: string): Promise<void>;
export declare function removeReaction(chatId: string, messageId: number): Promise<void>;
export declare function unpinJarvisMessage(chatId: string, messageId: number): Promise<void>;
/**
 * Send a video via the Jarvis bot.
 * videoBase64: base64-encoded MP4 bytes
 */
export declare function sendJarvisVideo(chatId: string, videoBase64: string, caption?: string): Promise<void>;
/**
 * Send a photo via the Jarvis bot.
 * imageBase64: base64-encoded PNG/JPEG bytes
 */
export declare function sendJarvisPhoto(chatId: string, imageBase64: string, caption?: string): Promise<void>;
export declare class TelegramChannel implements Channel {
    name: string;
    private bot;
    private opts;
    private botToken;
    constructor(botToken: string, opts: TelegramChannelOpts);
    connect(): Promise<void>;
    sendMessage(jid: string, text: string): Promise<void>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
    setTyping(jid: string, isTyping: boolean): Promise<void>;
}
//# sourceMappingURL=telegram.d.ts.map