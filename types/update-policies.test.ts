import { describe, it, expect } from 'vitest';
import { classifyUpdateType } from './update-policies';

describe('classifyUpdateType rollback detection', () => {
  it('classifies a downgrade as rollback', () => {
    expect(classifyUpdateType('2026.2.0.39747', '2026.1.3.36551')).toBe('rollback');
  });

  it('still classifies a forward upgrade correctly', () => {
    expect(classifyUpdateType('1.135.0', '1.137.0')).toBe('minor');
  });

  it('classifies an equal version as rollback-safe no-op, not a crash', () => {
    // Same version redeploy (e.g. editing install command only) - not a
    // version change at all, so not 'rollback' or a version-bump type.
    // classifyUpdateType only classifies version deltas; equal versions
    // fall through to the existing patch-level comparison (0.0.0 delta).
    expect(() => classifyUpdateType('3.0.22', '3.0.22')).not.toThrow();
  });
});
