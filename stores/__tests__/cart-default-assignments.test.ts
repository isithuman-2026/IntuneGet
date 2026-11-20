import { describe, it, expect, beforeEach } from 'vitest';
import { useCartStore } from '../cart-store';
import type { NewCartItem } from '@/types/upload';

const item = (assignments?: unknown[]) =>
  ({ appSource: 'store', wingetId: 'X', version: '1', packageIdentifier: 'X', installExperience: 'user', displayName: 'X', publisher: 'P', ...(assignments ? { assignments } : {}) }) as unknown as NewCartItem;

describe('cart default assignments', () => {
  beforeEach(() => useCartStore.setState({ items: [], defaultAssignments: [] }));

  it('fills empty assignments from defaults on add', () => {
    useCartStore.getState().setDefaultAssignments([{ type: 'allUsers', intent: 'available' }]);
    useCartStore.getState().addItem(item());
    useCartStore.getState().addItemSilent(item([]));
    expect(useCartStore.getState().items.map((i) => i.assignments)).toEqual([
      [{ type: 'allUsers', intent: 'available' }],
      [{ type: 'allUsers', intent: 'available' }],
    ]);
  });

  it('keeps explicit assignments', () => {
    useCartStore.getState().setDefaultAssignments([{ type: 'allUsers', intent: 'available' }]);
    useCartStore.getState().addItem(item([{ type: 'allDevices', intent: 'required' }]));
    expect(useCartStore.getState().items[0].assignments).toEqual([{ type: 'allDevices', intent: 'required' }]);
  });
});
