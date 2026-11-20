import { describe, it, expect } from 'vitest';
import { pickAssignedSourceApp } from './source-app';

describe('pickAssignedSourceApp', () => {
  const lookup = (assigned: Record<string, number | 'gone'>) => async (id: string) => {
    const v = assigned[id];
    if (v === 'gone') return null;
    return v ?? 0;
  };

  it('keeps the current app when it holds assignments', async () => {
    expect(await pickAssignedSourceApp('new', ['new', 'old'], lookup({ new: 1, old: 2 }))).toBe('new');
  });

  it('falls back to the newest older copy that still holds assignments', async () => {
    // Repro of the lab tenant: newest copies unassigned, an older copy still assigned
    expect(await pickAssignedSourceApp('v4', ['v4', 'v3', 'v2', 'v1'], lookup({ v4: 0, v3: 0, v2: 1, v1: 1 }))).toBe('v2');
  });

  it('skips deleted copies and returns the current app when none are assigned', async () => {
    expect(await pickAssignedSourceApp('v2', ['v2', 'v1'], lookup({ v2: 0, v1: 'gone' }))).toBe('v2');
  });
});
