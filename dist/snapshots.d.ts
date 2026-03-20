import { RegisteredGroup } from './types.js';
export interface AvailableGroup {
    jid: string;
    name: string;
    lastActivity: string;
    isRegistered: boolean;
}
/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export declare function getAvailableGroups(registeredGroups: Record<string, RegisteredGroup>): AvailableGroup[];
export declare function writeTasksSnapshot(groupFolder: string, isMain: boolean, tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
}>): void;
/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 */
export declare function writeGroupsSnapshot(groupFolder: string, isMain: boolean, groups: AvailableGroup[]): void;
/**
 * Write both task and group snapshots for a container.
 * Single call replaces the repeated boilerplate in runAgent, prespawnGroup, and task-scheduler.
 */
export declare function prepareAndWriteSnapshots(groupFolder: string, isMain: boolean, registeredGroups: Record<string, RegisteredGroup>): void;
//# sourceMappingURL=snapshots.d.ts.map