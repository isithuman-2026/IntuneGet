import type { Win32LobAppAssignment } from '@/types/intune';

/**
 * Key an assignment by target type + groupId (group/exclusionGroup) or by
 * target type alone (allDevices/allUsers are singletons). Two assignments
 * with the same key are the "same slot" — incoming wins.
 */
function assignmentKey(a: Win32LobAppAssignment): string {
  const odataType = a.target['@odata.type'];
  if (
    odataType === '#microsoft.graph.groupAssignmentTarget' ||
    odataType === '#microsoft.graph.exclusionGroupAssignmentTarget'
  ) {
    return `${odataType}:${a.target.groupId}`;
  }
  return odataType;
}

/**
 * Merge incoming assignments into an existing set, keyed by target. Graph's
 * POST .../assign replaces the full set, so any caller adding one
 * assignment must merge with the current set first or it silently deletes
 * every other assignment on the app.
 */
export function mergeAssignments(
  existing: Win32LobAppAssignment[],
  incoming: Win32LobAppAssignment[]
): Win32LobAppAssignment[] {
  const merged = new Map<string, Win32LobAppAssignment>();
  for (const a of existing) merged.set(assignmentKey(a), a);
  for (const a of incoming) merged.set(assignmentKey(a), a);
  return Array.from(merged.values());
}
