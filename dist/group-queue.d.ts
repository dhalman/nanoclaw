import { ChildProcess } from 'child_process';
export declare class GroupQueue {
    private groups;
    private activeCount;
    private waitingGroups;
    private processMessagesFn;
    private shuttingDown;
    private getGroup;
    setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void;
    enqueueMessageCheck(groupJid: string): void;
    enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void;
    registerProcess(groupJid: string, proc: ChildProcess, containerName: string, groupFolder?: string): void;
    /**
     * Kill the active container for a group immediately.
     * Returns true if a container was running and was killed.
     */
    killActive(groupJid: string): boolean;
    /**
     * Mark the container as idle-waiting (finished work, waiting for IPC input).
     * If tasks are pending, preempt the idle container immediately.
     */
    notifyIdle(groupJid: string): void;
    /**
     * Send a follow-up message to the active container via IPC file.
     * Returns true if the message was written, false if no active container.
     */
    sendMessage(groupJid: string, text: string): boolean;
    /**
     * Signal the active container to wind down by writing a close sentinel.
     */
    closeStdin(groupJid: string): void;
    /**
     * Pre-spawn a persistent container for a group.
     * Sets active=true for the lifetime of the container so messages route via IPC.
     * Returns when the container exits. Caller is responsible for restart logic.
     */
    prespawn(groupJid: string, groupFolder: string, spawnFn: () => Promise<void>): Promise<void>;
    private runForGroup;
    private runTask;
    private scheduleRetry;
    private drainGroup;
    private drainWaiting;
    shutdown(_gracePeriodMs: number): Promise<void>;
}
//# sourceMappingURL=group-queue.d.ts.map