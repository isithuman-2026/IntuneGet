import { describe, expect, it } from 'vitest';
import robots from '../robots';

describe('robots', () => {
  it('disallows the whole site for every agent', () => {
    const { rules } = robots();
    const list = Array.isArray(rules) ? rules : [rules];
    expect(list.length).toBeGreaterThan(0);
    for (const rule of list) {
      const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
      expect(disallow).toContain('/');
      expect(rule.allow ?? []).toEqual([]);
    }
  });
});
