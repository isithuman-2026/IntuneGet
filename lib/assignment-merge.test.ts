import { describe, it, expect } from 'vitest';
import { mergeAssignments } from './assignment-merge';
import type { Win32LobAppAssignment } from '@/types/intune';

function groupAssignment(groupId: string, intent: Win32LobAppAssignment['intent']): Win32LobAppAssignment {
  return {
    '@odata.type': '#microsoft.graph.mobileAppAssignment',
    intent,
    target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId },
  };
}

describe('mergeAssignments', () => {
  it('keeps existing assignments untouched when incoming targets a new group', () => {
    const existing = [groupAssignment('group-a', 'required')];
    const incoming = [groupAssignment('group-b', 'available')];
    const result = mergeAssignments(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([existing[0], incoming[0]]));
  });

  it('last-write-wins on intent when group id and target type match', () => {
    const existing = [groupAssignment('group-a', 'required')];
    const incoming = [groupAssignment('group-a', 'available')];
    const result = mergeAssignments(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0].intent).toBe('available');
  });

  it('treats allDevices/allLicensedUsers targets as their own singleton key, not group-keyed', () => {
    const existing: Win32LobAppAssignment[] = [
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'required', target: { '@odata.type': '#microsoft.graph.allDevicesAssignmentTarget' } },
    ];
    const incoming: Win32LobAppAssignment[] = [
      { '@odata.type': '#microsoft.graph.mobileAppAssignment', intent: 'available', target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget' } },
    ];
    const result = mergeAssignments(existing, incoming);
    expect(result).toHaveLength(2);
  });
});
