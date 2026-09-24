import { describe, expect, it } from 'vitest';
import {
  createPreviewStore,
  type StoredPreviewEntry,
} from '../../src/modules/import-export/service.js';

function entry(action: StoredPreviewEntry['action'] = 'new_item'): StoredPreviewEntry {
  return {
    candidate: {
      type: 'word',
      target: 'x',
      meaning: 'y',
      source_example: 'z',
      extra_examples: [],
      tags: [],
    },
    action,
    existingId: null,
  };
}

describe('createPreviewStore', () => {
  it('put 后 take 返回 payload，且 token 一次性（复用返回 null）', () => {
    const clock = 1_000;
    const store = createPreviewStore({ now: () => clock, ttlMs: 5_000 });
    const token = store.put([entry()]);
    expect(store.take(token)).toHaveLength(1);
    expect(store.take(token)).toBeNull();
  });

  it('过期后 take 返回 null（惰性清理）', () => {
    let clock = 1_000;
    const store = createPreviewStore({ now: () => clock, ttlMs: 5_000 });
    const token = store.put([entry()]);
    clock = 1_000 + 5_000 + 1; // TTL 2 小时的缩微版
    expect(store.take(token)).toBeNull();
  });

  it('不存在的 token 返回 null', () => {
    const store = createPreviewStore({ ttlMs: 5_000 });
    expect(store.take('no-such-token')).toBeNull();
  });

  it('put 时惰性清理已过期条目', () => {
    let clock = 1_000;
    const store = createPreviewStore({ now: () => clock, ttlMs: 5_000 });
    const t1 = store.put([entry()]);
    clock = 10_000;
    const t2 = store.put([entry('merge')]);
    expect(store.take(t1)).toBeNull(); // t1 已在 put 时被清理
    const payload = store.take(t2);
    expect(payload?.[0]?.action).toBe('merge');
  });
});
