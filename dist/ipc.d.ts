import { AvailableGroup } from './snapshots.js';
import { RegisteredGroup } from './types.js';
export interface IpcDeps {
    sendMessage: (jid: string, text: string) => Promise<void>;
    registeredGroups: () => Record<string, RegisteredGroup>;
    registerGroup: (jid: string, group: RegisteredGroup) => void;
    syncGroups: (force: boolean) => Promise<void>;
    getAvailableGroups: () => AvailableGroup[];
    writeGroupsSnapshot: (groupFolder: string, isMain: boolean, availableGroups: AvailableGroup[]) => void;
}
/** Call when a user message is received for a chatJid (no-op — status is always edit-in-place now). */
export declare function markUserActivity(_chatJid: string): void;
/**
 * Send or edit a status message. Always edits the existing pinned status
 * message if one exists. Only sends new when there's no prior message ID
 * or the edit fails (message deleted by user).
 */
export declare function sendOrEditStatus(chatJid: string, text: string): Promise<void>;
/**
 * Send "stopped" status to all registered groups that use the Jarvis bot.
 * Called from the host shutdown handler so the message is reliably delivered.
 */
export declare function sendStoppedStatus(registeredGroups: Record<string, RegisteredGroup>, assistantName: string): Promise<void>;
export declare function startIpcWatcher(deps: IpcDeps): void;
export declare function processTaskIpc(data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    service?: string;
    action?: string;
}, sourceGroup: string, // Verified identity from IPC directory
isMain: boolean, // Verified from directory path
deps: IpcDeps): Promise<void>;
//# sourceMappingURL=ipc.d.ts.map