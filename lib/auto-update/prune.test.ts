import { describe, it, expect } from 'vitest';
import { isPastGrace, isSafeToDelete } from './prune';

describe('auto-prune safety-gate logic', () => {
  const now = new Date('2026-09-29T00:00:00Z');

  it('is not past grace before the cutoff', () => {
    const supersededAt = new Date('2026-09-20T00:00:00Z').toISOString(); // 9 days ago
    expect(isPastGrace(supersededAt, 14, now)).toBe(false);
  });

  it('is past grace exactly at the cutoff', () => {
    const supersededAt = new Date('2026-09-15T00:00:00Z').toISOString(); // exactly 14 days ago
    expect(isPastGrace(supersededAt, 14, now)).toBe(true);
  });

  it('is past grace well after the cutoff', () => {
    const supersededAt = new Date('2026-08-01T00:00:00Z').toISOString();
    expect(isPastGrace(supersededAt, 14, now)).toBe(true);
  });

  it('is safe to delete only when both device counts are zero', () => {
    expect(isSafeToDelete({ installedDeviceCount: 0, pendingInstallDeviceCount: 0 })).toBe(true);
  });

  it('is not safe to delete with devices still installed', () => {
    expect(isSafeToDelete({ installedDeviceCount: 3, pendingInstallDeviceCount: 0 })).toBe(false);
  });

  it('is not safe to delete with a pending install', () => {
    expect(isSafeToDelete({ installedDeviceCount: 0, pendingInstallDeviceCount: 1 })).toBe(false);
  });
});
