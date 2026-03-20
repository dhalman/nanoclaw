import fs from 'fs';
import path from 'path';
import { getAllChats, getAllTasks } from './db.js';
import { resolveGroupIpcPath } from './group-folder.js';
/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(registeredGroups) {
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
export function writeTasksSnapshot(groupFolder, isMain, tasks) {
    const groupIpcDir = resolveGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    const filteredTasks = isMain
        ? tasks
        : tasks.filter((t) => t.groupFolder === groupFolder);
    const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}
/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 */
export function writeGroupsSnapshot(groupFolder, isMain, groups) {
    const groupIpcDir = resolveGroupIpcPath(groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    const visibleGroups = isMain ? groups : [];
    const groupsFile = path.join(groupIpcDir, 'available_groups.json');
    fs.writeFileSync(groupsFile, JSON.stringify({
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
    }, null, 2));
}
/** Map raw DB tasks to the snapshot format. */
function mapTasks(tasks) {
    return tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
    }));
}
/**
 * Write both task and group snapshots for a container.
 * Single call replaces the repeated boilerplate in runAgent, prespawnGroup, and task-scheduler.
 */
export function prepareAndWriteSnapshots(groupFolder, isMain, registeredGroups) {
    writeTasksSnapshot(groupFolder, isMain, mapTasks(getAllTasks()));
    writeGroupsSnapshot(groupFolder, isMain, getAvailableGroups(registeredGroups));
}
//# sourceMappingURL=snapshots.js.map